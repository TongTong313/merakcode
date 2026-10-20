import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { FileTime } from "../file/time"
import { RuleSession } from "../rule/session-state"
import { Atomic } from "../file/atomic"
import { Filesystem } from "@merakcode/util/filesystem"
import { Instance } from "../project/instance"
import { Workspace } from "../project/workspace"
import { trimDiff } from "./edit"
import { Snapshot } from "../snapshot"
import { isProjectFileBypass } from "./file-bypass"
import { assertCanWritePlanDoc, assertPlanModeAllowsWrite } from "./plan-doc"
import { ToolPathGuard } from "./path-guard"
import { MemoryAccess } from "../memory/access"
import { ContextAttach } from "../session/context-attach"
import { PermissionPolicy } from "../permission/policy"

const MAX_DIAGNOSTICS_PER_FILE = 20
const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const WriteTool = Tool.define("write", {
  description: DESCRIPTION,
  parameters: z.object({
    // filePath comes before content: models stream arguments in schema order, so the UI gets the file name while
    // content is still streaming and can show a file card right away instead of appearing stuck on large writes.
    filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
    content: z.string().describe("The content to write to the file"),
  }),
  async execute(params, ctx) {
    const filepath = Workspace.resolveToolPath(Instance.workspace, params.filePath).filepath
    // Checked before writing, as in read, so the model cannot leak sensitive file contents through write diffs
    await ToolPathGuard.assertPathAllowed(ctx, filepath, "write")
    await assertCanWritePlanDoc(ctx, filepath)
    // Plan mode forbids writing project files; this points to plan_exit before the permission layer's DeniedError
    await assertPlanModeAllowsWrite(ctx, filepath)
    const bypass = await isProjectFileBypass({
      agent: ctx.agent,
      permissionMode: ctx.permissionMode,
      filePath: filepath,
      sessionID: ctx.sessionID,
      access: "write",
    })
    // Access outside the workspace is not asked about here; in controlled sessions the sandbox blocks it by workDirs.

    // As in edit.ts, read, assert, ask, write and update the read time all inside withLock. Otherwise there is a
    // TOCTOU window between the assert and the write, and concurrent writes to the same file lose updates.
    let exists = false
    let contentOld = ""
    await FileTime.withLock(filepath, async () => {
      exists = await Filesystem.isFile(filepath)
      contentOld = exists ? await Filesystem.readText(filepath) : ""
      if (exists) await FileTime.assert(ctx.sessionID, filepath)

      const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
      if (!bypass) {
        await ctx.ask({
          permission: "edit",
          checks: [PermissionPolicy.file({ op: "write", path: filepath, ...PermissionPolicy.scope() })],
          metadata: {
            filepath,
            diff,
          },
        })
      }

      if (!bypass) await Snapshot.trackFile(filepath, ctx.sessionID)
      // Checks the memory directory itself rather than bypass (which plan files also set), and scans for credentials
      // so real secrets do not end up in memory files that are recalled again and again
      if (MemoryAccess.isWritablePath(filepath)) MemoryAccess.assertNoSecrets(params.content)
      await Atomic.write(filepath, params.content)
      if (!bypass) {
        await Bus.publish(File.Event.Edited, {
          file: filepath,
        })
        await Bus.publish(FileWatcher.Event.Updated, {
          file: filepath,
          event: exists ? "change" : "add",
        })
      }
      FileTime.read(ctx.sessionID, filepath)
    })
    await RuleSession.touchFromTool(ctx, filepath)

    let output = "Wrote file successfully."
    let diagnostics: Record<string, import("../lsp/client").LSPClient.Diagnostic[]> = {}
    if (!bypass) {
      diagnostics = await LSP.diagnosticsAfterEdit([filepath])
      const normalizedFilepath = Filesystem.normalizePath(filepath)
      let projectDiagnosticsCount = 0
      for (const [file, issues] of Object.entries(diagnostics)) {
        const errors = issues.filter((item) => item.severity === 1)
        if (errors.length === 0) continue
        const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
        const suffix =
          errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
        if (file === normalizedFilepath) {
          output += `\n\nLSP errors detected in this file, please fix:\n<diagnostics file="${filepath}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
          continue
        }
        if (projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
        projectDiagnosticsCount++
        output += `\n\nLSP errors detected in other files:\n<diagnostics file="${file}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
      }
    }

    const filediff: Snapshot.FileDiff = {
      file: filepath,
      before: contentOld,
      after: params.content,
      additions: 0,
      deletions: 0,
    }
    for (const change of diffLines(contentOld, params.content)) {
      if (change.added) filediff.additions += change.count || 0
      if (change.removed) filediff.deletions += change.count || 0
    }

    // New files need no prior read, so this is where the directory's AGENTS.md is most easily missed
    const instructions = await ContextAttach.forFile({
      filepath,
      trigger: "write",
      messageID: ctx.messageID,
      messages: ctx.messages,
      agent: ctx.agent,
    })

    return {
      title: path.relative(Instance.worktree, filepath),
      metadata: {
        diagnostics,
        filepath,
        exists,
        filediff,
        loaded: instructions.map((i) => i.filepath),
      },
      output: output + ContextAttach.render(instructions),
    }
  },
})
