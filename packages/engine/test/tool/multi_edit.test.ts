import { describe, expect, test } from "vitest"
import path from "path"
import * as fs from "fs/promises"
// Import Session first so message.ts is fully initialized; otherwise the tool/multi_edit -> ../lsp ->
// ../session/message import chain sees the LSP namespace before it is ready.
import "@merakcode/engine/agent/session/index"
import { MultiEditTool } from "@merakcode/engine/agent/tools/multi_edit"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { FileTime } from "@merakcode/engine/infra/file/time"
import { Global } from "@merakcode/engine/infra/global/index"
import { Filesystem } from "@merakcode/util/filesystem"

const makeCtx = (
  sessionID = "test",
  overrides?: { agent?: string; permissionMode?: "readonly" | "ask"; ask?: () => Promise<void> },
) => ({
  sessionID,
  messageID: "",
  callID: "",
  agent: overrides?.agent ?? "build",
  permissionMode: overrides?.permissionMode ?? ("ask" as const),
  kind: overrides?.permissionMode ?? ("ask" as const),
  abort: AbortSignal.any([]),
  messages: [],
  ruleset: [],
  metadata: () => {},
  ask: overrides?.ask ?? (async () => {}),
})

describe("multi_edit: basic sequential edits", () => {
  test("applies multiple edits in sequence atomically", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "target.txt"), "line one\nline two\nline three\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "target.txt")
        const ctx = makeCtx()
        FileTime.read(ctx.sessionID, filePath)
        const tool = await MultiEditTool.init()
        const result = await tool.execute(
          {
            filePath,
            edits: [
              { oldString: "line one", newString: "LINE ONE" },
              { oldString: "line two", newString: "LINE TWO" },
            ],
          },
          ctx,
        )
        const content = await Filesystem.readText(filePath)
        expect(content).toContain("LINE ONE")
        expect(content).toContain("LINE TWO")
        expect(content).toContain("line three")
        expect(result.output).toContain("2 edit(s)")
      },
    })
  })

  test("second edit sees result of first edit", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "target.txt"), "aaa bbb")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "target.txt")
        const ctx = makeCtx()
        FileTime.read(ctx.sessionID, filePath)
        const tool = await MultiEditTool.init()
        await tool.execute(
          {
            filePath,
            edits: [
              { oldString: "aaa", newString: "AAA" },
              { oldString: "AAA bbb", newString: "AAA BBB" },
            ],
          },
          ctx,
        )
        const content = await Filesystem.readText(filePath)
        expect(content).toBe("AAA BBB")
      },
    })
  })
})

describe("multi_edit: atomicity on failure", () => {
  test("file is NOT modified if any edit fails", async () => {
    const original = "hello world"
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "target.txt"), original)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "target.txt")
        const ctx = makeCtx()
        FileTime.read(ctx.sessionID, filePath)
        const tool = await MultiEditTool.init()
        await expect(
          tool.execute(
            {
              filePath,
              edits: [
                { oldString: "hello", newString: "HELLO" },
                { oldString: "notfound", newString: "WHATEVER" },
              ],
            },
            ctx,
          ),
        ).rejects.toThrow()
        const content = await Filesystem.readText(filePath)
        expect(content).toBe(original)
      },
    })
  })

  test("rejects when oldString equals newString", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "target.txt"), "abc")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "target.txt")
        const ctx = makeCtx()
        FileTime.read(ctx.sessionID, filePath)
        const tool = await MultiEditTool.init()
        await expect(
          tool.execute(
            {
              filePath,
              edits: [{ oldString: "abc", newString: "abc" }],
            },
            ctx,
          ),
        ).rejects.toThrow()
      },
    })
  })
})

describe("multi_edit: create-file mode (oldString = '')", () => {
  test("creates a new file with seed content and applies subsequent edits", async () => {
    await using tmp = await tmpdir({})
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "newfile.txt")
        const ctx = makeCtx()
        const tool = await MultiEditTool.init()
        await tool.execute(
          {
            filePath,
            edits: [
              { oldString: "", newString: "hello world" },
              { oldString: "hello", newString: "HELLO" },
            ],
          },
          ctx,
        )
        const content = await Filesystem.readText(filePath)
        expect(content).toBe("HELLO world")
      },
    })
  })

  test("fails in create mode if file already exists", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "existing.txt"), "already here")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "existing.txt")
        const ctx = makeCtx()
        FileTime.read(ctx.sessionID, filePath)
        const tool = await MultiEditTool.init()
        await expect(
          tool.execute(
            {
              filePath,
              edits: [{ oldString: "", newString: "overwrite attempt" }],
            },
            ctx,
          ),
        ).rejects.toThrow()
      },
    })
  })
})

describe("multi_edit: sequential dependency between edits", () => {
  test("edits in the wrong order fail as a whole when an oldString only exists after a later edit", async () => {
    // The intended order is alpha -> ALPHA, then "ALPHA beta" -> "ALPHA BETA". Reversed, the first oldString does
    // not exist yet, so the call must throw and leave the file untouched.
    const original = "alpha beta"
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "target.txt"), original)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "target.txt")
        const ctx = makeCtx()
        FileTime.read(ctx.sessionID, filePath)
        const tool = await MultiEditTool.init()
        await expect(
          tool.execute(
            {
              filePath,
              edits: [
                { oldString: "ALPHA beta", newString: "ALPHA BETA" },
                { oldString: "alpha", newString: "ALPHA" },
              ],
            },
            ctx,
          ),
        ).rejects.toThrow()
        const content = await Filesystem.readText(filePath)
        expect(content).toBe(original)
      },
    })
  })
})

describe("multi_edit: plan bypass", () => {
  test("in plan mode, paths under Global.Path.data/plans do not ask", async () => {
    // On the plan bypass, multi_edit skips the permission ask (and Snapshot, Bus and LSP; only the ask is checked).
    // ask throws, so passing proves the bypass took effect.
    const planDir = path.join(Global.Path.data, "plans")
    await fs.mkdir(planDir, { recursive: true })
    const planFile = path.join(planDir, `${Date.now()}-bypass-${Math.random().toString(36).slice(2)}.md`)
    await using tmp = await tmpdir({ git: true })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ctx = makeCtx("test", {
            permissionMode: "readonly",
            ask: async () => {
              throw new Error("ask should NOT be called on plan-bypass path")
            },
          })
          const tool = await MultiEditTool.init()
          // The empty oldString creates the plan file; the second edit patches the seed content
          await tool.execute(
            {
              filePath: planFile,
              edits: [
                { oldString: "", newString: "# Plan\n\nstep 1\n" },
                { oldString: "step 1", newString: "STEP 1" },
              ],
            },
            ctx,
          )
          const content = await Filesystem.readText(planFile)
          expect(content).toBe("# Plan\n\nSTEP 1\n")
        },
      })
    } finally {
      await fs.unlink(planFile).catch(() => {})
    }
  })
})

describe("multi_edit: replaceAll", () => {
  test("replaceAll replaces every occurrence", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "target.txt"), "foo foo foo")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "target.txt")
        const ctx = makeCtx()
        FileTime.read(ctx.sessionID, filePath)
        const tool = await MultiEditTool.init()
        await tool.execute(
          {
            filePath,
            edits: [{ oldString: "foo", newString: "bar", replaceAll: true }],
          },
          ctx,
        )
        const content = await Filesystem.readText(filePath)
        expect(content).toBe("bar bar bar")
      },
    })
  })
})
