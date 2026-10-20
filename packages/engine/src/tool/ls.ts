import z from "zod"
import { Tool } from "./tool"
import * as path from "path"
import DESCRIPTION from "./ls.txt"
import { Instance } from "../project/instance"
import { Workspace } from "../project/workspace"
import { Ripgrep } from "../file/ripgrep"
import { ToolPathGuard } from "./path-guard"
import { ToolResultDelta } from "./result-delta"
import { PermissionPolicy } from "../permission/policy"

export const IGNORE_PATTERNS = [
  "node_modules/",
  "__pycache__/",
  ".git/",
  "dist/",
  "build/",
  "target/",
  "vendor/",
  "bin/",
  "obj/",
  ".idea/",
  ".vscode/",
  ".zig-cache/",
  "zig-out",
  ".coverage",
  "coverage/",
  "vendor/",
  "tmp/",
  "temp/",
  ".cache/",
  "cache/",
  "logs/",
  ".venv/",
  "venv/",
  "env/",
]

const LIMIT = 100
const MAX_LIMIT = 1000

export const ListTool = Tool.define("ls", {
  description: DESCRIPTION,
  parameters: z.object({
    path: z.string().describe("The absolute path to the directory to list (must be absolute, not relative)").optional(),
    ignore: z.array(z.string()).describe("List of glob patterns to ignore").optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Maximum number of files to include"),
  }),
  async execute(params, ctx) {
    const searchPath = Workspace.resolveToolPath(Instance.workspace, params.path || ".").filepath
    await ToolPathGuard.assertPathAllowed(ctx, searchPath, "ls")

    await ctx.ask({
      permission: "ls",
      checks: PermissionPolicy.search("ls", searchPath, searchPath),
      metadata: {
        path: searchPath,
      },
    })

    const ignoreGlobs = IGNORE_PATTERNS.map((p) => `!${p}*`).concat(params.ignore?.map((p) => `!${p}`) || [])
    const limit = params.limit ?? LIMIT
    const files = []
    let truncated = false
    for await (const file of Ripgrep.files({ cwd: searchPath, glob: ignoreGlobs, signal: ctx.abort })) {
      if (files.length >= limit) {
        truncated = true
        break
      }
      const full = path.resolve(searchPath, file)
      if (!(await ToolPathGuard.filterAllowedPaths(ctx, [full], "ls")).length) continue
      files.push(file)
    }

    // Build directory structure
    const dirs = new Set<string>()
    const filesByDir = new Map<string, string[]>()

    for (const file of files) {
      const dir = path.dirname(file)
      const parts = dir === "." ? [] : dir.split("/")

      // Add all parent directories
      for (let i = 0; i <= parts.length; i++) {
        const dirPath = i === 0 ? "." : parts.slice(0, i).join("/")
        dirs.add(dirPath)
      }

      // Add file to its directory
      if (!filesByDir.has(dir)) filesByDir.set(dir, [])
      filesByDir.get(dir)!.push(path.basename(file))
    }

    function renderDir(dirPath: string, depth: number): string {
      const indent = "  ".repeat(depth)
      let output = ""

      if (depth > 0) {
        output += `${indent}${path.basename(dirPath)}/\n`
      }

      const childIndent = "  ".repeat(depth + 1)
      const children = Array.from(dirs)
        .filter((d) => path.dirname(d) === dirPath && d !== dirPath)
        .sort()

      // Render subdirectories first
      for (const child of children) {
        output += renderDir(child, depth + 1)
      }

      // Render files
      const files = filesByDir.get(dirPath) || []
      for (const file of files.sort()) {
        output += `${childIndent}${file}\n`
      }

      return output
    }

    const dirCount = Math.max(0, dirs.size - 1)
    const summary = `Summary: ${files.length} files shown, ${dirCount} directories${truncated ? `, truncated at ${limit}` : ""}`
    const output = `${searchPath}/\n${summary}\n` + renderDir(".", 0)
    const delta = await ToolResultDelta.check({
      tool: "ls",
      sessionID: ctx.sessionID,
      key: JSON.stringify({ path: searchPath, ignore: params.ignore ?? [], limit }),
      output,
      ttlMs: 30_000,
    })

    return {
      title: path.relative(Instance.worktree, searchPath),
      metadata: {
        count: files.length,
        directories: dirCount,
        truncated,
        ...(delta && { delta: true }),
      },
      output: delta ?? output,
    }
  },
})
