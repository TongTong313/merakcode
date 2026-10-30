import z from "zod"
import fs, { unlink } from "fs/promises"
import { Process } from "@merakcode/util/process"
import { Tool } from "./tool"
import { Ripgrep } from "../../infra/file/ripgrep"

import DESCRIPTION from "./grep.txt"
import { Instance } from "../../infra/project/instance"
import { Workspace } from "../../infra/project/workspace"
import path from "path"
import { ToolPathGuard } from "./path-guard"
import { ToolResultDelta } from "./result-delta"
import { createToolOutputSink } from "./output-sink"
import { ContextAttach } from "../context/context-attach"
import { PermissionPolicy } from "../permission/policy"

const MAX_LINE_LENGTH = 2000
const DEFAULT_LIMIT = 100
const DEFAULT_MAX_PER_FILE = 6

type Match = {
  path: string
  modTime: number
  lineNum: number
  lineText: string
}

function displayPath(filePath: string) {
  const relative = path.relative(Instance.directory, filePath)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.replace(/\\/g, "/") : filePath
}

function truncateLine(text: string) {
  return text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + "..." : text
}

function emptyResult(title: string) {
  return {
    title,
    metadata: {
      matches: 0,
      files: 0,
      truncated: false,
      delta: false,
    },
    output: "No matches found",
  }
}

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to all workspace folders when omitted."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
    limit: z.number().int().min(1).max(1000).optional().describe("Maximum number of matches to show"),
    maxPerFile: z.number().int().min(1).max(20).optional().describe("Maximum matches to show per file"),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    await ctx.ask({
      permission: "grep",
      checks: PermissionPolicy.search(
        "grep",
        params.pattern,
        params.path ? Workspace.resolveToolPath(Instance.workspace, params.path).filepath : undefined,
      ),
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    // With a path, search only that root; without one, search every workspace folder
    const roots = Workspace.searchRoots(Instance.workspace, params.path)
    for (const searchPath of roots) {
      await ToolPathGuard.assertPathAllowed(ctx, searchPath, "grep")
    }

    const rgPath = await Ripgrep.filepath()
    if (!rgPath) {
      return {
        title: params.pattern,
        metadata: { matches: 0, files: 0, truncated: false, delta: false },
        output: "No files found (ripgrep unavailable; install rg or allow GitHub access to enable content search)",
      }
    }
    const args = [
      "-nH",
      "--hidden",
      "--no-messages",
      "--glob=!.git/*",
      "--field-match-separator=|",
      "--regexp",
      params.pattern,
    ]
    if (params.include) {
      args.push("--glob", params.include)
    }

    const rawOutput = await createToolOutputSink()
    const rawOutputPath = rawOutput.path
    const cleanupRawOutput = async () => {
      rawOutput.destroy()
      await unlink(rawOutputPath).catch(() => {})
    }

    const limit = params.limit ?? DEFAULT_LIMIT
    const maxPerFile = params.maxPerFile ?? DEFAULT_MAX_PER_FILE
    const fileStats = new Map<string, number>()
    const fileCounts = new Map<string, number>()
    const matchesByFile = new Map<string, Match[]>()
    let totalMatches = 0
    let hasErrors = false

    const statFile = async (filePath: string) => {
      const cached = fileStats.get(filePath)
      if (cached !== undefined) return cached
      const stats = await fs
        .stat(filePath)
        .then((x) => x.mtime.getTime())
        .catch(() => 0)
      fileStats.set(filePath, stats)
      return stats
    }

    const pushMatch = async (line: string) => {
      if (!line) return

      const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
      if (!filePath || !lineNumStr || lineTextParts.length === 0) return

      if (!(await ToolPathGuard.filterAllowedPaths(ctx, [filePath], "grep")).length) return

      const lineNum = Number.parseInt(lineNumStr, 10)
      if (!Number.isFinite(lineNum)) return

      totalMatches++
      rawOutput.append(line + "\n")

      fileCounts.set(filePath, (fileCounts.get(filePath) ?? 0) + 1)
      const bucket = matchesByFile.get(filePath) ?? []
      if (bucket.length < maxPerFile) {
        bucket.push({
          path: filePath,
          modTime: await statFile(filePath),
          lineNum,
          lineText: lineTextParts.join("|"),
        })
        matchesByFile.set(filePath, bucket)
      }
    }

    // Streams one process's stdout into the shared matchesByFile / rawOutput
    const readMatches = async (proc: Process.Child) => {
      const reader = proc.stdout!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          ctx.abort.throwIfAborted()
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            await pushMatch(line)
          }
        }
        if (buffer) await pushMatch(buffer)
      } finally {
        reader.releaseLock()
      }
    }

    // Multi-root workspaces: run rg for each root in turn and merge the streamed results
    for (const searchPath of roots) {
      const proc = Process.spawn([rgPath, ...args, searchPath], {
        stdout: "pipe",
        stderr: "pipe",
        signal: ctx.abort,
      })

      try {
        await readMatches(proc)
      } catch (error) {
        await cleanupRawOutput()
        throw error
      }

      const [errorOutput, exitCode] = await (async () => {
        try {
          return await Promise.all([new Response(proc.stderr).text(), proc.exited])
        } catch (error) {
          await cleanupRawOutput()
          throw error
        }
      })()

      // Exit codes: 0 = matches found, 1 = no matches, 2 = errors (but may still have matches)
      // With --no-messages, we suppress error output but still get exit code 2 for broken symlinks etc.
      if (exitCode === 1) continue
      if (exitCode === 2 && totalMatches === 0) {
        hasErrors = true
        continue
      }
      if (exitCode !== 0 && exitCode !== 2) {
        await cleanupRawOutput()
        throw new Error(`ripgrep failed: ${errorOutput}`)
      }
      if (exitCode === 2) hasErrors = true
    }

    // rawOutput is shared by all roots and can only be closed once, after the last search
    try {
      await rawOutput.close()
    } catch (error) {
      await cleanupRawOutput()
      throw error
    }

    if (totalMatches === 0) {
      await unlink(rawOutputPath).catch(() => {})
      return emptyResult(params.pattern)
    }

    const files = [...matchesByFile.entries()]
      .map(([filePath, matches]) => ({
        filePath,
        matches,
        total: fileCounts.get(filePath) ?? matches.length,
        modTime: fileStats.get(filePath) ?? 0,
      }))
      .sort((a, b) => b.modTime - a.modTime || a.filePath.localeCompare(b.filePath))

    if (files.length === 0) {
      await unlink(rawOutputPath).catch(() => {})
      return emptyResult(params.pattern)
    }

    const outputLines = [`Found ${totalMatches} matches in ${files.length} files`]
    let shown = 0

    for (const file of files) {
      if (shown >= limit) break
      outputLines.push("", `${displayPath(file.filePath)}:`)
      let shownInFile = 0
      for (const match of file.matches) {
        if (shown >= limit) break
        outputLines.push(`  Line ${match.lineNum}: ${truncateLine(match.lineText)}`)
        shown++
        shownInFile++
      }

      const omittedInFile = Math.max(0, file.total - shownInFile)
      if (omittedInFile > 0) outputLines.push(`  [+${omittedInFile} more matches in this file omitted]`)
    }

    const truncated = shown < totalMatches
    if (truncated) {
      outputLines.push("")
      outputLines.push(
        `(Results truncated: showing ${shown} of ${totalMatches} matches (${totalMatches - shown} hidden). Consider using a more specific path or pattern.)`,
      )
    }

    if (hasErrors) {
      outputLines.push("")
      outputLines.push("(Some paths were inaccessible and skipped)")
    }

    const deltaOutput = outputLines.join("\n")
    const delta = await ToolResultDelta.check({
      tool: "grep",
      sessionID: ctx.sessionID,
      key: JSON.stringify({ pattern: params.pattern, path: params.path, include: params.include, limit, maxPerFile }),
      output: deltaOutput,
      ttlMs: 60_000,
    })

    if (delta) {
      await unlink(rawOutputPath).catch(() => {})
      return {
        title: params.pattern,
        metadata: {
          matches: totalMatches,
          files: files.length,
          truncated: false,
          delta: true,
        },
        output: delta,
      }
    }

    if (truncated) outputLines.push(`Full raw matches saved to: ${rawOutputPath}`)
    else await unlink(rawOutputPath).catch(() => {})

    const stableOutput = outputLines.join("\n")

    // Attached after the delta check so instructions are not compared: their deduplicated injection differs between
    // calls and would make the same query look like it changed
    const instructions = await ContextAttach.forSearchHits({
      files: files.map((f) => f.filePath),
      messageID: ctx.messageID,
      messages: ctx.messages,
      agent: ctx.agent,
    })

    return {
      title: params.pattern,
      metadata: {
        matches: totalMatches,
        files: files.length,
        truncated,
        delta: false,
        outputPath: truncated ? rawOutputPath : undefined,
        rawOutputPath: truncated ? rawOutputPath : undefined,
        loaded: instructions.map((i) => i.filepath),
      },
      output: stableOutput + ContextAttach.render(instructions),
    }
  },
})
