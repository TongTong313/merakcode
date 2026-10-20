import z from "zod"
import fs from "node:fs/promises"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./multi_edit.txt"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Bus } from "../bus"
import { FileTime } from "../file/time"
import { RuleSession } from "../rule/session-state"
import { Atomic } from "../file/atomic"
import { Snapshot } from "../snapshot"
import { Filesystem } from "@merakcode/util/filesystem"
import { Instance } from "../project/instance"
import { Workspace } from "../project/workspace"
import { replace, trimDiff, normalizeLineEndings } from "./edit"
import { isProjectFileBypass } from "./file-bypass"
import { assertCanWritePlanDoc, assertPlanModeAllowsWrite } from "./plan-doc"
import { ToolPathGuard } from "./path-guard"
import { MemoryAccess } from "../memory/access"
import { PermissionPolicy } from "../permission/policy"

const MAX_DIAGNOSTICS_PER_FILE = 20

export const MultiEditTool = Tool.define("multi_edit", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to modify"),
    edits: z
      .array(
        z.object({
          oldString: z.string().describe("The text to replace"),
          newString: z.string().describe("The text to replace it with (must be different from oldString)"),
          replaceAll: z.boolean().optional().describe("Replace all occurrences of oldString (default false)"),
        }),
      )
      .min(1)
      .describe(
        "Sequential edits to apply to the same file. Each edit's oldString is matched against the buffer produced by all prior edits in this call.",
      ),
  }),
  async execute(params, ctx) {
    if (!params.filePath) throw new Error("filePath is required")

    // Reject no-op edits before reading or locking. replace() checks this too; failing here is earlier and the
    // message includes the edits[i] index.
    for (let i = 0; i < params.edits.length; i++) {
      const e = params.edits[i]
      if (e.oldString === e.newString) throw new Error(`edits[${i}]: oldString equals newString (no-op)`)
    }

    const filePath = Workspace.resolveToolPath(Instance.workspace, params.filePath).filepath
    // Checked before writing, as in read, so the model cannot leak sensitive file contents through multi_edit diffs
    await ToolPathGuard.assertPathAllowed(ctx, filePath, "multi_edit")
    await assertCanWritePlanDoc(ctx, filePath)
    // Plan mode forbids writing project files; this points to plan_exit before the permission layer's DeniedError
    await assertPlanModeAllowsWrite(ctx, filePath)
    const bypass = await isProjectFileBypass({
      agent: ctx.agent,
      permissionMode: ctx.permissionMode,
      filePath,
      sessionID: ctx.sessionID,
      access: "write",
    })
    // Access outside the workspace is not asked about here; in controlled sessions the sandbox blocks it by workDirs.

    let diff = ""
    let contentOld = ""
    let contentNew = ""
    let createdNew = false

    await FileTime.withLock(filePath, async () => {
      const stats = await fs.stat(filePath).catch(() => undefined)
      const firstIsCreate = params.edits[0].oldString === ""

      if (firstIsCreate) {
        if (stats) throw new Error(`multi_edit cannot create: file already exists at ${filePath}`)
        contentNew = params.edits[0].newString
        for (let i = 1; i < params.edits.length; i++) {
          const e = params.edits[i]
          try {
            contentNew = replace(contentNew, e.oldString, e.newString, e.replaceAll)
          } catch (err) {
            throw new Error(`edits[${i}]: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        createdNew = true
      } else {
        if (!stats) throw new Error(`File ${filePath} not found`)
        if (stats.isDirectory()) throw new Error(`Path is a directory: ${filePath}`)
        await FileTime.assert(ctx.sessionID, filePath)
        contentOld = await Filesystem.readText(filePath)
        contentNew = contentOld
        for (let i = 0; i < params.edits.length; i++) {
          const e = params.edits[i]
          try {
            contentNew = replace(contentNew, e.oldString, e.newString, e.replaceAll)
          } catch (err) {
            throw new Error(`edits[${i}]: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }

      // As in edit.ts, normalize CRLF to LF before diffing so ^M does not show up on Windows
      diff = trimDiff(
        createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)),
      )

      if (!bypass) {
        await ctx.ask({
          permission: "edit",
          checks: [PermissionPolicy.file({ op: "write", path: filePath, ...PermissionPolicy.scope() })],
          metadata: { filepath: filePath, diff, editCount: params.edits.length },
        })
      }

      if (!bypass) await Snapshot.trackFile(filePath, ctx.sessionID)
      if (MemoryAccess.isWritablePath(filePath)) MemoryAccess.assertNoSecrets(contentNew)
      await Atomic.write(filePath, contentNew)
      if (!bypass) {
        await Bus.publish(File.Event.Edited, { file: filePath })
        await Bus.publish(FileWatcher.Event.Updated, {
          file: filePath,
          event: createdNew ? "add" : "change",
        })
      }
      FileTime.read(ctx.sessionID, filePath)
    })

    await RuleSession.touchFromTool(ctx, filePath)

    const filediff: Snapshot.FileDiff = {
      file: filePath,
      before: contentOld,
      after: contentNew,
      additions: 0,
      deletions: 0,
    }
    for (const change of diffLines(contentOld, contentNew)) {
      if (change.added) filediff.additions += change.count || 0
      if (change.removed) filediff.deletions += change.count || 0
    }

    // Metadata is sent twice for streaming: the diff goes to the UI right away with empty diagnostics, then LSP runs
    // (skipped on a plan bypass, otherwise it can take hundreds of milliseconds) and the real diagnostics come back in
    // the return value. The UI keeps the latest metadata, so this empty diagnostics object does not override them.
    ctx.metadata({
      metadata: { diff, filediff, editCount: params.edits.length, diagnostics: {} },
    })

    let output = `Applied ${params.edits.length} edit(s) to ${path.relative(Instance.worktree, filePath)}.`
    let diagnostics: Record<string, import("../lsp/client").LSPClient.Diagnostic[]> = {}
    if (!bypass) {
      diagnostics = await LSP.diagnosticsAfterEdit([filePath])
      const issues = diagnostics[Filesystem.normalizePath(filePath)] ?? []
      const errors = issues.filter((x) => x.severity === 1)
      if (errors.length > 0) {
        const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
        const suffix =
          errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
        output += `\n\nLSP errors detected in this file, please fix:\n<diagnostics file="${filePath}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
      }
    }

    return {
      metadata: { diagnostics, diff, filediff },
      title: path.relative(Instance.worktree, filePath),
      output,
    }
  },
})
