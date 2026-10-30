import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import DESCRIPTION from "./glob.txt"
import { Ripgrep } from "../../infra/file/ripgrep"
import { Instance } from "../../infra/project/instance"
import { Workspace } from "../../infra/project/workspace"
import { ToolPathGuard } from "./path-guard"
import { ToolResultDelta } from "./result-delta"
import { ContextAttach } from "../context/context-attach"
import { PermissionPolicy } from "../permission/policy"

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const MAX_CANDIDATE_MULTIPLIER = 20

function displayPath(filePath: string) {
  const relative = path.relative(Instance.directory, filePath)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.replace(/\\/g, "/") : filePath
}

async function statMtime(filePath: string) {
  return fs
    .stat(filePath)
    .then((x) => x.mtime.getTime())
    .catch(() => 0)
}

export const GlobTool = Tool.define("glob", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z
      .string()
      .optional()
      .describe(
        `The directory to search in. If not specified, searches all workspace folders. IMPORTANT: Omit this field to use the default. DO NOT enter "undefined" or "null". Must be a valid directory path if provided.`,
      ),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Maximum number of matching paths to show"),
    sort: z.enum(["mtime", "path"]).optional().describe("Sort results by modification time or path"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "glob",
      checks: PermissionPolicy.search(
        "glob",
        params.pattern,
        params.path ? Workspace.resolveToolPath(Instance.workspace, params.path).filepath : undefined,
      ),
      metadata: {
        pattern: params.pattern,
        path: params.path,
      },
    })

    const roots = Workspace.searchRoots(Instance.workspace, params.path)
    for (const search of roots) {
      await ToolPathGuard.assertPathAllowed(ctx, search, "glob")
    }

    const limit = params.limit ?? DEFAULT_LIMIT
    const sort = params.sort ?? "mtime"
    const candidateLimit =
      sort === "mtime" ? Math.min(MAX_LIMIT * MAX_CANDIDATE_MULTIPLIER, limit * MAX_CANDIDATE_MULTIPLIER) : limit + 1
    const candidates: string[] = []
    let candidateTruncated = false
    // Multi-root workspaces: scan each root in turn; candidateLimit counts across all roots
    for (const search of roots) {
      if (candidateTruncated) break
      for await (const file of Ripgrep.files({
        cwd: search,
        glob: [params.pattern],
        signal: ctx.abort,
      })) {
        if (candidates.length >= candidateLimit) {
          candidateTruncated = true
          break
        }
        const full = path.resolve(search, file)
        if (!(await ToolPathGuard.filterAllowedPaths(ctx, [full], "glob")).length) continue
        candidates.push(full)
      }
    }

    const files =
      sort === "path"
        ? candidates.map((file) => ({ path: file, mtime: 0 })).sort((a, b) => a.path.localeCompare(b.path))
        : await Promise.all(candidates.map(async (file) => ({ path: file, mtime: await statMtime(file) }))).then(
            (items) => items.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)),
          )

    const shown = files.slice(0, limit)
    const truncated = candidateTruncated || files.length > shown.length

    const output = []
    if (shown.length === 0) output.push("No files found")
    if (shown.length > 0) {
      output.push(
        `Found ${candidateTruncated ? `${files.length}+` : files.length} matches (showing ${shown.length}, sorted by ${sort})`,
      )
      output.push("")
      output.push(...shown.map((f) => displayPath(f.path)))
      if (truncated) {
        output.push("")
        output.push(
          candidateTruncated
            ? `(Results are truncated after scanning ${candidateLimit} candidates. Consider using a more specific path or pattern.)`
            : `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
        )
      }
    }

    const titleRoot = roots.length === 1 ? roots[0] : Instance.directory
    const stableOutput = output.join("\n")
    const delta = await ToolResultDelta.check({
      tool: "glob",
      sessionID: ctx.sessionID,
      key: JSON.stringify({ pattern: params.pattern, path: params.path, limit, sort }),
      output: stableOutput,
      ttlMs: 30_000,
    })
    // Attached after the delta check so instructions are not compared: their deduplicated injection differs between
    // calls and would make the same query look like it changed
    const instructions = delta
      ? []
      : await ContextAttach.forSearchHits({
          files: shown.map((f) => f.path),
          messageID: ctx.messageID,
          messages: ctx.messages,
          agent: ctx.agent,
        })

    return {
      title: Workspace.displayPath(Instance.workspace, titleRoot),
      metadata: {
        count: shown.length,
        candidates: files.length,
        truncated,
        ...(delta && { delta: true }),
        loaded: instructions.map((i) => i.filepath),
      },
      output: (delta ?? stableOutput) + ContextAttach.render(instructions),
    }
  },
})
