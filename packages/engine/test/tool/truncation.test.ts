import { describe, test, expect, afterAll } from "vitest"
import { Truncate } from "@merakcode/engine/tool/truncation"
import { Identifier } from "@merakcode/util/id"
import fs from "fs/promises"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"

describe("Truncate", () => {
  describe("output", () => {
    test("truncates large json file by bytes", async () => {
      const content = "x".repeat(80 * 1024)
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("truncated...")
      if (result.truncated) expect(result.outputPath).toBeDefined()
    })

    test("returns content unchanged when under limits", async () => {
      const content = "line1\nline2\nline3"
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(false)
      expect(result.content).toBe(content)
    })

    test("truncates by line count", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 10 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("...90 lines truncated...")
    })

    test("truncates by byte count", async () => {
      const content = "a".repeat(1000)
      const result = await Truncate.output(content, { maxBytes: 100 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("truncated...")
    })

    test("truncates from head by default", async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 3 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("line0")
      expect(result.content).toContain("line1")
      expect(result.content).toContain("line2")
      expect(result.content).not.toContain("line9")
    })

    test("truncates from tail when direction is tail", async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 3, direction: "tail" })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("line7")
      expect(result.content).toContain("line8")
      expect(result.content).toContain("line9")
      expect(result.content).not.toContain("line0")
    })

    test("uses default MAX_LINES and MAX_BYTES", () => {
      expect(Truncate.MAX_LINES).toBe(2000)
      expect(Truncate.MAX_BYTES).toBe(50 * 1024)
    })

    test("large single-line file truncates with byte message", async () => {
      const content = "x".repeat(80 * 1024)
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("bytes truncated...")
      expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(Truncate.MAX_BYTES)
    })

    test("writes full output to file when truncated", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 10 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("The tool call succeeded but the output was truncated")
      expect(result.content).toContain("Grep")
      if (!result.truncated) throw new Error("expected truncated")
      expect(result.outputPath).toBeDefined()
      expect(result.outputPath).toContain("tool_")

      const written = await Filesystem.readText(result.outputPath)
      expect(written).toBe(lines)
    })

    test("suggests subagent tool when agent has subagent permission", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const agent = { permission: [{ permission: "subagent", pattern: "*", action: "allow" as const }] }
      const result = await Truncate.output(lines, { maxLines: 10 }, agent as any)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("Grep")
      expect(result.content).toContain("subagent tool")
    })

    test("omits subagent tool hint when agent lacks subagent permission", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const agent = { permission: [{ permission: "subagent", pattern: "*", action: "deny" as const }] }
      const result = await Truncate.output(lines, { maxLines: 10 }, agent as any)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("Grep")
      expect(result.content).not.toContain("subagent tool")
    })

    test("does not write file when not truncated", async () => {
      const content = "short content"
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(false)
      if (result.truncated) throw new Error("expected not truncated")
      expect("outputPath" in result).toBe(false)
    })
  })

  describe("cleanup", () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    let oldFile: string
    let recentFile: string

    afterAll(async () => {
      await fs.unlink(oldFile).catch(() => {})
      await fs.unlink(recentFile).catch(() => {})
    })

    test("deletes files older than 7 days and preserves recent files", async () => {
      await fs.mkdir(Truncate.DIR, { recursive: true })

      // Create an old file (10 days ago)
      const oldTimestamp = Date.now() - 10 * DAY_MS
      const oldId = Identifier.ascending("tool")
      oldFile = path.join(Truncate.DIR, oldId)
      await Filesystem.write(oldFile, "old content")
      await fs.utimes(oldFile, new Date(oldTimestamp), new Date(oldTimestamp))

      // Create a recent file (3 days ago)
      const recentTimestamp = Date.now() - 3 * DAY_MS
      const recentId = Identifier.ascending("tool")
      recentFile = path.join(Truncate.DIR, recentId)
      await Filesystem.write(recentFile, "recent content")
      await fs.utimes(recentFile, new Date(recentTimestamp), new Date(recentTimestamp))

      await Truncate.cleanup()

      // Old file should be deleted
      expect(await Filesystem.isFile(oldFile)).toBe(false)

      // Recent file should still exist
      expect(await Filesystem.isFile(recentFile)).toBe(true)
    })
  })
})
