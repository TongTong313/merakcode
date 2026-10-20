import path from "path"
import fs from "fs/promises"
import matter from "gray-matter"
import { Filesystem } from "@merakcode/util/filesystem"
import { MemoryPath } from "./path"
import { MEMORY_TYPES, parseMemoryType, type MemoryType } from "./types"

export namespace MemoryScan {
  export const MAX_MEMORY_FILES = 200
  export const FRONTMATTER_MAX_LINES = 30
  export const FRONTMATTER_MAX_BYTES = 64 * 1024

  export type Header = {
    filename: string
    path: string
    mtimeMs: number
    name: string | null
    description: string | null
    type: MemoryType | undefined
  }

  /**
   * Cache entries are keyed on the mtimes of the four type directories. Adding, deleting or replacing a file changes
   * its directory's mtime, which triggers a rescan. In steady state each recall costs 4 stats instead of 200 head
   * reads.
   *
   * Keyed by memoryDir rather than Instance: files() already takes memoryDir, so the cache also works without an
   * Instance context (e.g. pure unit tests). Recall and extract share the cache.
   */
  type CacheEntry = { key: string; files: Header[] }
  const cache = new Map<string, CacheEntry>()

  /** Drops the cache, e.g. after writing a memory file directly, so the next read sees the change */
  export function invalidate(memoryDir = MemoryPath.directory()) {
    cache.delete(memoryDir)
  }

  export async function files(memoryDir = MemoryPath.directory()): Promise<Header[]> {
    const key = await dirSignature(memoryDir)
    const entry = cache.get(memoryDir)
    if (entry && entry.key === key) return entry.files

    const files = await scan(memoryDir)
    cache.set(memoryDir, { key, files })
    return files
  }

  /** mtime signature of the four type directories; a missing directory is "-" so it never matches a cached key */
  async function dirSignature(memoryDir: string): Promise<string> {
    const stamps = await Promise.all(
      MEMORY_TYPES.map(async (type) => {
        const dir = path.join(memoryDir, type)
        try {
          const stat = await fs.stat(dir)
          return stat.mtimeMs.toString()
        } catch {
          return "-"
        }
      }),
    )
    return stamps.join("|")
  }

  async function scan(memoryDir: string): Promise<Header[]> {
    const candidates = (await Promise.all(MEMORY_TYPES.map((type) => markdownFiles(path.join(memoryDir, type))))).flat()
    const results = await Promise.allSettled(candidates.map((file) => header(memoryDir, file)))

    return results
      .filter((result): result is PromiseFulfilledResult<Header> => result.status === "fulfilled")
      .map((result) => result.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES)
  }

  async function markdownFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const current = path.join(dir, entry.name)
        if (entry.isDirectory()) return markdownFiles(current)
        if (!entry.isFile()) return []
        if (path.basename(current) === MemoryPath.ENTRYPOINT_NAME) return []
        if (!current.toLowerCase().endsWith(".md")) return []
        return [path.resolve(current)]
      }),
    )
    return nested.flat()
  }

  async function header(memoryDir: string, filePath: string): Promise<Header> {
    const [content, stat] = await Promise.all([head(filePath), fs.stat(filePath)])
    const parsed = matter(content)
    return {
      filename: path.relative(memoryDir, filePath),
      path: path.resolve(filePath),
      mtimeMs: stat.mtime.getTime(),
      name: stringValue(parsed.data.name),
      description: stringValue(parsed.data.description),
      type: parseMemoryType(parsed.data.type),
    }
  }

  async function head(filePath: string) {
    const content = new TextDecoder().decode(await Filesystem.readRange(filePath, 0, FRONTMATTER_MAX_BYTES))
    return content.split(/\r?\n/).slice(0, FRONTMATTER_MAX_LINES).join("\n")
  }

  function stringValue(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : null
  }
}
