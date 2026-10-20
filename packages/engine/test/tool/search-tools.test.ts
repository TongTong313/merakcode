import { describe, expect, test as baseTest } from "vitest"
// ripgrep streaming and Instance.provide setup are slow on Windows, so every test gets 30s
const test = (name: string, fn: () => void | Promise<void>, timeout = 30_000) => baseTest(name, fn, timeout)
import fs from "fs/promises"
import path from "path"
import { GlobTool } from "@merakcode/engine/tool/glob"
import { GrepTool } from "@merakcode/engine/tool/grep"
import { ListTool } from "@merakcode/engine/tool/ls"
import { ToolResultDelta } from "@merakcode/engine/tool/result-delta"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

const ctx = {
  sessionID: "search-test",
  messageID: "",
  callID: "",
  agent: "build",
  kind: "ask" as const,
  abort: AbortSignal.any([]),
  messages: [],
  ruleset: [],
  metadata: () => {},
  ask: async () => {},
  askExternalDirectory: async () => {},
}

describe("search tools", () => {
  test("glob shows newest matches after scanning a candidate window", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        const oldFile = path.join(dir, "src", "old.ts")
        const newFile = path.join(dir, "src", "new.ts")
        await Filesystem.write(oldFile, "old")
        await Filesystem.write(newFile, "new")
        await fs.utimes(oldFile, new Date("2020-01-01"), new Date("2020-01-01"))
        await fs.utimes(newFile, new Date("2025-01-01"), new Date("2025-01-01"))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/*.ts", limit: 1 }, ctx)

        expect(result.output).toContain("Found 2 matches")
        expect(result.output).toContain("src/new.ts")
        expect(result.output).not.toContain("src/old.ts")
        expect(result.metadata.truncated).toBe(true)
      },
    })
  })

  test("grep streams matches, groups by file, and preserves raw output when truncated", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Filesystem.write(
          path.join(dir, "src", "a.ts"),
          Array.from({ length: 10 }, (_, i) => `const a${i} = "TODO ${i}"`).join("\n"),
        )
        await Filesystem.write(path.join(dir, "src", "b.ts"), `const b = "TODO b"\nconst c = "TODO c"`)
        await fs.utimes(path.join(dir, "src", "a.ts"), new Date("2025-01-01"), new Date("2025-01-01"))
        await fs.utimes(path.join(dir, "src", "b.ts"), new Date("2020-01-01"), new Date("2020-01-01"))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute({ pattern: "TODO", include: "*.ts", limit: 3, maxPerFile: 2 }, ctx)

        expect(result.output).toContain("Found 12 matches in 2 files")
        expect(result.output).toContain("src/a.ts:")
        expect(result.output).toContain("[+8 more matches in this file omitted]")
        expect(result.output).toContain("Full raw matches saved to:")
        expect(result.metadata.truncated).toBe(true)
        expect(typeof (result.metadata as any).rawOutputPath).toBe("string")
        expect(await Filesystem.readText((result.metadata as any).rawOutputPath)).toContain("TODO 9")
      },
    })
  })

  test("ls only marks truncated after seeing an extra entry", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "a.txt"), "a")
        await Filesystem.write(path.join(dir, "b.txt"), "b")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ls = await ListTool.init()
        const result = await ls.execute({ limit: 2 }, ctx)

        expect(result.output).toContain("Summary: 2 files shown")
        expect(result.metadata.truncated).toBe(false)
      },
    })
  })

  test("tool result delta can collapse repeated glob output", async () => {
    const previous = process.env.MERAKCODE_EXPERIMENTAL_TOOL_RESULT_DELTA
    process.env.MERAKCODE_EXPERIMENTAL_TOOL_RESULT_DELTA = "1"
    ToolResultDelta.clear()

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Filesystem.write(path.join(dir, "a.ts"), "a")
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const glob = await GlobTool.init()
          const first = await glob.execute({ pattern: "**/*.ts" }, ctx)
          const second = await glob.execute({ pattern: "**/*.ts" }, ctx)

          expect(first.output).toContain("a.ts")
          expect(second.output).toContain("[unchanged] same glob result")
          expect((second.metadata as any).delta).toBe(true)
        },
      })
    } finally {
      if (previous === undefined) delete process.env.MERAKCODE_EXPERIMENTAL_TOOL_RESULT_DELTA
      else process.env.MERAKCODE_EXPERIMENTAL_TOOL_RESULT_DELTA = previous
      ToolResultDelta.clear()
    }
  })

  test("tool result delta can be enabled through project config", async () => {
    const previous = process.env.MERAKCODE_EXPERIMENTAL_TOOL_RESULT_DELTA
    delete process.env.MERAKCODE_EXPERIMENTAL_TOOL_RESULT_DELTA
    ToolResultDelta.clear()

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await fs.mkdir(path.join(dir, ".merakcode"), { recursive: true })
          await Filesystem.write(
            path.join(dir, ".merakcode", "merakcode.jsonc"),
            JSON.stringify({
              experimental: {
                tool_result_delta: true,
              },
            }),
          )
          // Keep the file under src/ and anchor the glob there: with a .merakcode/ directory the engine installs
          // dependencies into .merakcode/node_modules in the background, which changes the file set between the two
          // globs and makes the second result not "unchanged"
          await Filesystem.write(path.join(dir, "src", "a.ts"), "a")
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const glob = await GlobTool.init()
          const first = await glob.execute({ pattern: "src/**/*.ts" }, ctx)
          const second = await glob.execute({ pattern: "src/**/*.ts" }, ctx)

          expect(first.output).toContain("a.ts")
          expect(second.output).toContain("[unchanged] same glob result")
          expect((second.metadata as any).delta).toBe(true)
        },
      })
    } finally {
      if (previous === undefined) delete process.env.MERAKCODE_EXPERIMENTAL_TOOL_RESULT_DELTA
      else process.env.MERAKCODE_EXPERIMENTAL_TOOL_RESULT_DELTA = previous
      ToolResultDelta.clear()
    }
  })
})
