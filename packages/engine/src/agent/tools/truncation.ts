import fs from "fs/promises"
import path from "path"
import { Global } from "../../infra/global"
import { Identifier } from "@merakcode/util/id"
import { PermissionNext } from "../permission/next"
import type { Agent } from "../agent"
import { Filesystem } from "@merakcode/util/filesystem"
import { Glob } from "@merakcode/util/glob"

export namespace Truncate {
  export const MAX_LINES = 2000
  export const MAX_BYTES = 50 * 1024
  export const DIR = path.join(Global.Path.data, "tool-output")
  export const GLOB = path.join(DIR, "*")
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

  export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

  export interface Options {
    maxLines?: number
    maxBytes?: number
    direction?: "head" | "tail"
  }

  export async function cleanup() {
    const cutoff = Date.now() - RETENTION_MS
    const glob = new Glob("tool_*")
    const entries = await Array.fromAsync(glob.scan({ cwd: DIR, onlyFiles: true })).catch(() => [] as string[])
    for (const entry of entries) {
      const filepath = path.join(DIR, entry)
      const stat = await fs.stat(filepath).catch(() => undefined)
      if (!stat || stat.mtimeMs >= cutoff) continue
      await fs.unlink(filepath).catch(() => {})
    }
  }

  // The subagent tool counts as available unless it is denied (allow and ask both count)
  function hasSubAgentTool(agent?: Agent.Info): boolean {
    if (!agent?.permission) return false
    const rule = PermissionNext.evaluate("subagent", "*", agent.permission)
    return rule.action !== "deny"
  }

  function hint(filepath: string, agent?: Agent.Info): string {
    return hasSubAgentTool(agent)
      ? `The tool call succeeded but the output was truncated. Full output saved to: ${filepath}\nUse the subagent tool with the explore agent to process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
      : `The tool call succeeded but the output was truncated. Full output saved to: ${filepath}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`
  }

  function fit(text: string, maxLines: number, maxBytes: number, direction: "head" | "tail") {
    const lines = text.split("\n")
    const out: string[] = []
    let bytes = 0
    let hitBytes = false

    if (direction === "head") {
      for (let i = 0; i < lines.length && i < maxLines; i++) {
        const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
        if (bytes + size > maxBytes) {
          hitBytes = true
          break
        }
        out.push(lines[i])
        bytes += size
      }
    } else {
      for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
        const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
        if (bytes + size > maxBytes) {
          hitBytes = true
          break
        }
        out.unshift(lines[i])
        bytes += size
      }
    }

    return { preview: out.join("\n"), bytes, lines: out.length, hitBytes, totalLines: lines.length }
  }

  function format(
    preview: string,
    removed: number,
    unit: "bytes" | "lines",
    filepath: string,
    direction: "head" | "tail",
    agent?: Agent.Info,
  ) {
    const message =
      direction === "head"
        ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint(filepath, agent)}`
        : `...${removed} ${unit} truncated...\n\n${hint(filepath, agent)}\n\n${preview}`
    return message
  }

  function fromText(text: string, filepath: string, options: Options = {}, agent?: Agent.Info): Result {
    const maxLines = options.maxLines ?? MAX_LINES
    const maxBytes = options.maxBytes ?? MAX_BYTES
    const direction = options.direction ?? "head"
    const totalBytes = Buffer.byteLength(text, "utf-8")
    const lines = text.split("\n")

    if (lines.length <= maxLines && totalBytes <= maxBytes) {
      return { content: text, truncated: false }
    }

    const fitted = fit(text, maxLines, maxBytes, direction)
    const removed = fitted.hitBytes ? totalBytes - fitted.bytes : lines.length - fitted.lines
    const unit = fitted.hitBytes ? "bytes" : "lines"

    return {
      content: format(fitted.preview, removed, unit, filepath, direction, agent),
      truncated: true,
      outputPath: filepath,
    }
  }

  export async function output(text: string, options: Options = {}, agent?: Agent.Info): Promise<Result> {
    const checked = fromText(text, "", options, agent)
    if (!checked.truncated) return checked
    const id = Identifier.ascending("tool")
    const filepath = path.join(DIR, id)
    await fs.mkdir(DIR, { recursive: true })
    await Filesystem.write(filepath, text)
    return fromText(text, filepath, options, agent)
  }

  /**
   * Truncates text already in memory, but points to an existing file for the full original.
   *
   * Used after lossless compaction: the folded text is smaller and may no longer need truncating. If it still does,
   * truncating the folded text means the bytes saved by folding leave more content. The original stays at filepath
   * and the hint still points the model there.
   */
  export function outputText(text: string, filepath: string, options: Options = {}, agent?: Agent.Info): Result {
    return fromText(text, filepath, options, agent)
  }

  export async function outputFile(filepath: string, options: Options = {}, agent?: Agent.Info): Promise<Result> {
    const maxLines = options.maxLines ?? MAX_LINES
    const maxBytes = options.maxBytes ?? MAX_BYTES
    const direction = options.direction ?? "head"
    const totalBytes = await Filesystem.size(filepath)

    if (totalBytes <= maxBytes) {
      return fromText(await Filesystem.readText(filepath), filepath, options, agent)
    }

    const start = direction === "tail" ? Math.max(0, totalBytes - maxBytes) : 0
    const end = direction === "tail" ? totalBytes : maxBytes
    const fitted = fit(
      new TextDecoder().decode(await Filesystem.readRange(filepath, start, end)),
      maxLines,
      maxBytes,
      direction,
    )
    const removed = Math.max(0, totalBytes - fitted.bytes)
    return {
      content: format(fitted.preview, removed, "bytes", filepath, direction, agent),
      truncated: true,
      outputPath: filepath,
    }
  }
}
