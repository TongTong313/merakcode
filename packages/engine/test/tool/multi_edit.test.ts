import { Session } from "@merakcode/engine/agent/session/index"
import { describe, expect, test } from "vitest"
import path from "path"
// Import Session first so message.ts is fully initialized; otherwise the tool/multi_edit -> ../lsp ->
// ../session/message import chain sees the LSP namespace before it is ready.
import "@merakcode/engine/agent/session/index"
import { MultiEditTool } from "@merakcode/engine/agent/tools/multi_edit"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { FileTime } from "@merakcode/engine/infra/file/time"
import { SessionPlan } from "@merakcode/engine/agent/session/plan"
import { Filesystem } from "@merakcode/util/filesystem"

const makeCtx = (
  sessionID = "test",
  overrides?: { agent?: string; permissionLevel?: "ask" | "autoApprove" | "fullTakeover"; ask?: () => Promise<void> },
) => ({
  sessionID,
  messageID: "",
  callID: "",
  agent: overrides?.agent ?? "build",
  permissionLevel: overrides?.permissionLevel ?? ("autoApprove" as const),
  kind: overrides?.permissionLevel ?? ("autoApprove" as const),
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

describe("multi_edit: official plan protection", () => {
  test("generic edits cannot replace the dedicated official plan save", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const plan = await SessionPlan.save({
          sessionID: session.id,
          source: "human",
          content: "# Plan\nstep 1",
          expectedRevision: 0,
        })
        const ctx = makeCtx(session.id, {
          permissionLevel: "fullTakeover",
          ask: async () => {
            throw new Error("Generic plan writes must fail before approval")
          },
        })
        const tool = await MultiEditTool.init()
        await expect(
          tool.execute({ filePath: plan.path, edits: [{ oldString: "step 1", newString: "CHANGED" }] }, ctx),
        ).rejects.toMatchObject({ name: "PlanConflictError" })
        expect(await Filesystem.readText(plan.path)).toBe("# Plan\nstep 1")
        expect((await SessionPlan.get(session.id)).revision).toBe(1)
      },
    })
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
