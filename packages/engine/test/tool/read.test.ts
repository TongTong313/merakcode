import { describe, expect, test } from "vitest"
import path from "path"
import { ReadTool } from "@merakcode/engine/tool/read"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { PermissionNext } from "@merakcode/engine/permission/next"
import { PermissionPolicy } from "@merakcode/engine/permission/policy"
import type { Tool } from "@merakcode/engine/tool/tool"
import { Filesystem } from "@merakcode/util/filesystem"

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures")

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  kind: "ask" as const,
  abort: AbortSignal.any([]),
  messages: [],
  ruleset: [],
  metadata: () => {},
  ask: async () => {},
}

/** Evaluate each read permission check against the mode's ruleset: record asks, throw on denials */
function recorder(mode: PermissionPolicy.Mode = "ask") {
  const asked: string[] = []
  const testCtx = {
    ...ctx,
    ask: async (req: Parameters<Tool.Context["ask"]>[0]) => {
      for (const check of req.checks ?? []) {
        const action = PermissionNext.evaluate(check.permission, check.pattern, PermissionPolicy.ruleset(mode)).action
        if (action === "deny") throw new PermissionNext.DeniedError([])
        if (action === "ask") asked.push(check.permission)
      }
    },
  }
  return { asked, ctx: testCtx }
}

describe("tool.read inside and outside the workspace", () => {
  test("reads files inside the workspace, including subdirectories, without asking", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "test.txt"), "hello world")
        await Filesystem.write(path.join(dir, "subdir", "test.txt"), "nested content")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const probe = recorder()
        expect((await read.execute({ filePath: path.join(tmp.path, "test.txt") }, probe.ctx)).output).toContain(
          "hello world",
        )
        expect((await read.execute({ filePath: "subdir/test.txt" }, probe.ctx)).output).toContain("nested content")
        expect(probe.asked).toEqual([])
      },
    })
  })

  test("outside files and directories ask for external_read in ask mode and are read directly in auto", async () => {
    await using outer = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "notes.txt"), "outside data")
        await Filesystem.write(path.join(dir, "external", "a.txt"), "a")
      },
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const ask = recorder("ask")
        expect((await read.execute({ filePath: path.join(outer.path, "notes.txt") }, ask.ctx)).output).toContain(
          "outside data",
        )
        expect((await read.execute({ filePath: path.join(outer.path, "external") }, ask.ctx)).output).toContain("a.txt")
        expect(ask.asked).toEqual(["external_read", "external_read"])

        const auto = recorder("auto")
        await read.execute({ filePath: path.join(outer.path, "notes.txt") }, auto.ctx)
        expect(auto.asked).toEqual([])
      },
    })
  })

  test("multi-root workspace: reading from the second root does not ask", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "other.txt"), "from second root")
      },
    })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "a", path: a.path },
          { name: "b", path: b.path },
        ],
      },
      fn: async () => {
        const read = await ReadTool.init()
        const probe = recorder()
        const result = await read.execute({ filePath: path.join(b.path, "other.txt") }, probe.ctx)
        expect(result.output).toContain("from second root")
        expect(probe.asked).toEqual([])
      },
    })
  })
})

describe("tool.read sensitive files", () => {
  const cases: [string, boolean][] = [
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    [".env.development.local", true],
    [".env.example", false],
    ["production.env", false],
    [".envrc", false],
    ["environment.ts", false],
  ]

  describe.each(["ask", "auto"] as const)("mode=%s", (mode) => {
    test.each(cases)("%s asks=%s", async (filename, shouldAsk) => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => Filesystem.write(path.join(dir, filename), "content"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const probe = recorder(mode)
          const read = await ReadTool.init()
          await read.execute({ filePath: path.join(tmp.path, filename) }, probe.ctx)
          expect(probe.asked.includes("sensitive_read")).toBe(shouldAsk)
        },
      })
    })
  })
})

describe("tool.read truncation", () => {
  test("truncates large file by bytes and sets truncated metadata", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const content = Array.from({ length: 2000 }, () => "x".repeat(40)).join("\n")
        await Filesystem.write(path.join(dir, "large.json"), content)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "large.json") }, ctx)
        expect(result.metadata.truncated).toBe(true)
        expect(result.output).toContain("Output truncated at")
        expect(result.output).toContain("bytes")
      },
    })
  })

  test("truncates by line count when limit is specified", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        await Filesystem.write(path.join(dir, "many-lines.txt"), lines)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "many-lines.txt"), limit: 10 }, ctx)
        expect(result.metadata.truncated).toBe(true)
        expect(result.output).toContain("File has more lines")
        expect(result.output).toContain("line0")
        expect(result.output).toContain("line9")
        expect(result.output).not.toContain("line10")
      },
    })
  })

  test("does not truncate small file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "small.txt"), "hello world")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "small.txt") }, ctx)
        expect(result.metadata.truncated).toBe(false)
        expect(result.output).toContain("End of file")
      },
    })
  })

  test("respects offset parameter", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")
        await Filesystem.write(path.join(dir, "offset.txt"), lines)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "offset.txt"), offset: 10, limit: 5 }, ctx)
        expect(result.output).toContain("line10")
        expect(result.output).toContain("line14")
        expect(result.output).not.toContain("line0")
        expect(result.output).not.toContain("line15")
      },
    })
  })

  test("throws when offset is beyond end of file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const lines = Array.from({ length: 3 }, (_, i) => `line${i + 1}`).join("\n")
        await Filesystem.write(path.join(dir, "short.txt"), lines)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        await expect(
          read.execute({ filePath: path.join(tmp.path, "short.txt"), offset: 4, limit: 5 }, ctx),
        ).rejects.toThrow("Offset 4 is out of range for this file (3 lines)")
      },
    })
  })

  test("does not mark final directory page as truncated", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            Filesystem.write(path.join(dir, "dir", `file-${i + 1}.txt`), `line${i}`),
          ),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "dir"), offset: 6, limit: 5 }, ctx)
        expect(result.metadata.truncated).toBe(false)
        expect(result.output).not.toContain("Showing 5 of 10 entries")
      },
    })
  })

  test("truncates long lines", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const longLine = "x".repeat(3000)
        await Filesystem.write(path.join(dir, "long-line.txt"), longLine)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "long-line.txt") }, ctx)
        expect(result.output).toContain("...")
        expect(result.output.length).toBeLessThan(3000)
      },
    })
  })

  test("image files set truncated to false", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // 1x1 red PNG
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
          "base64",
        )
        await Filesystem.write(path.join(dir, "image.png"), png)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "image.png") }, ctx)
        expect(result.metadata.truncated).toBe(false)
        expect(result.attachments).toBeDefined()
        expect(result.attachments?.length).toBe(1)
      },
    })
  })

  test("large image files are properly attached without error", async () => {
    await Instance.provide({
      directory: FIXTURES_DIR,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(FIXTURES_DIR, "large-image.png") }, ctx)
        expect(result.metadata.truncated).toBe(false)
        expect(result.attachments).toBeDefined()
        expect(result.attachments?.length).toBe(1)
        expect(result.attachments?.[0].type).toBe("file")
      },
    })
  })

  test(".fbs files (FlatBuffers schema) are read as text, not images", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // FlatBuffers schema content
        const fbsContent = `namespace MyGame;

table Monster {
  pos:Vec3;
  name:string;
  inventory:[ubyte];
}

root_type Monster;`
        await Filesystem.write(path.join(dir, "schema.fbs"), fbsContent)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "schema.fbs") }, ctx)
        // Should be read as text, not as image
        expect(result.attachments).toBeUndefined()
        expect(result.output).toContain("namespace MyGame")
        expect(result.output).toContain("table Monster")
      },
    })
  })
})

describe("tool.read loaded instructions", () => {
  test("loads AGENTS.md from parent directory and includes in metadata", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "subdir", "AGENTS.md"), "# Test Instructions\nDo something special.")
        await Filesystem.write(path.join(dir, "subdir", "nested", "test.txt"), "test content")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "subdir", "nested", "test.txt") }, ctx)
        expect(result.output).toContain("test content")
        expect(result.output).toContain("system-reminder")
        expect(result.output).toContain("Test Instructions")
        expect(result.metadata.loaded).toBeDefined()
        expect(result.metadata.loaded).toContain(path.join(tmp.path, "subdir", "AGENTS.md"))
      },
    })
  })
})

describe("tool.read streaming for large files", () => {
  // About 87 bytes per line; 140k lines is about 11.3MB, above the 10MB streaming threshold.
  const LINE = "x".repeat(80)
  const LARGE_LINE_COUNT = 140_000

  function buildLargeContent(lineCount = LARGE_LINE_COUNT) {
    return Array.from({ length: lineCount }, (_, i) => `line${i + 1}:${LINE}`).join("\n")
  }

  test("streams only the requested window from a large file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "large.txt"), buildLargeContent())
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "large.txt"), offset: 1, limit: 5 }, ctx)
        expect(result.output).toContain("1: line1:")
        expect(result.output).toContain("5: line5:")
        expect(result.output).not.toContain("6: line6:")
        expect(result.output).toContain("File has more lines")
        expect(result.metadata.truncated).toBe(true)
      },
    })
  })

  test("reports precise total line count when the window reaches the real end of a large file", async () => {
    const lineCount = LARGE_LINE_COUNT
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "large-tail.txt"), buildLargeContent(lineCount))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute(
          { filePath: path.join(tmp.path, "large-tail.txt"), offset: lineCount - 2, limit: 10 },
          ctx,
        )
        expect(result.output).toContain(`End of file - total ${lineCount} lines`)
        expect(result.metadata.truncated).toBe(false)
      },
    })
  })

  test("throws when offset is beyond the end of a large file", async () => {
    const lineCount = LARGE_LINE_COUNT
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "large-oob.txt"), buildLargeContent(lineCount))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        await expect(
          read.execute({ filePath: path.join(tmp.path, "large-oob.txt"), offset: lineCount + 100, limit: 5 }, ctx),
        ).rejects.toThrow(`Offset ${lineCount + 100} is out of range for this file (${lineCount} lines)`)
      },
    })
  })

  test("truncates by bytes within the streaming path", async () => {
    // 1990-char lines stay under MAX_LINE_LENGTH so clampLine leaves them alone; about 26 of them exceed
    // MAX_BYTES (50KB), which exercises the byte truncation branch of the streaming path.
    const paddedLine = "z".repeat(1990)
    const paddingLines = Array.from({ length: 60 }, () => paddedLine).join("\n")
    await using tmp = await tmpdir({
      init: async (dir) => {
        const content = [paddingLines, buildLargeContent()].join("\n")
        await Filesystem.write(path.join(dir, "large-bytes.txt"), content)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute(
          { filePath: path.join(tmp.path, "large-bytes.txt"), offset: 1, limit: 60 },
          ctx,
        )
        expect(result.metadata.truncated).toBe(true)
        expect(result.output).toContain("Output truncated at")
        expect(result.output).toContain("bytes")
      },
    })
  })

  test("does not scan a huge single line that lies beyond the requested window", async () => {
    // Regression: hasMoreLines used to wait for the newline ending the first line past the window, so a huge
    // single line after the window meant scanning the whole file. Any byte past the window must be enough to stop.
    const hugeLine = "h".repeat(30 * 1024 * 1024) // 30MB single line without newlines
    await using tmp = await tmpdir({
      init: async (dir) => {
        const content = ["short first line", hugeLine].join("\n")
        await Filesystem.write(path.join(dir, "huge-line.txt"), content)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const started = Date.now()
        const result = await read.execute({ filePath: path.join(tmp.path, "huge-line.txt"), offset: 1, limit: 1 }, ctx)
        const elapsedMs = Date.now() - started
        expect(result.output).toContain("short first line")
        expect(result.output).not.toContain("hhhh")
        expect(result.output).toContain("File has more lines")
        expect(result.metadata.truncated).toBe(true)
        // Loose guard, not a performance SLA: scanning the whole 30MB line would clearly exceed this limit.
        expect(elapsedMs).toBeLessThan(3000)
      },
    })
  })
})

describe("tool.read builtin-skill URI", () => {
  test("reads flat builtin skill subfiles without touching disk", async () => {
    const read = await ReadTool.init()
    const reference = await read.execute({ filePath: "builtin-skill://pdf/pdf-parse-reference.md" }, ctx)
    expect(reference.output).toContain("# pdf_parse tool reference")

    await expect(read.execute({ filePath: "builtin-skill://pdf/nested/pdf-parse-reference.md" }, ctx)).rejects.toThrow(
      "Nested paths not supported",
    )
  })

  test("still rejects path traversal in builtin-skill URI", async () => {
    const read = await ReadTool.init()
    await expect(read.execute({ filePath: "builtin-skill://pdf/../checklist.md" }, ctx)).rejects.toThrow(
      "Path traversal not allowed",
    )
  })
})
