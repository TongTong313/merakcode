import { afterEach, describe, expect, test, type Mock, vi } from "vitest"
import path from "path"
import { Plugin } from "@merakcode/engine/agent/plugin/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { ReadTool } from "@merakcode/engine/agent/tools/read"
import { ToolPathGuard } from "@merakcode/engine/agent/tools/path-guard"
import { tmpdir } from "../fixture/fixture"
import type { Message } from "@merakcode/engine/agent/session/message"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * Tool-level path guard seam `tool/path-guard.ts`.
 *
 * The engine has no built-in sensitive-path rules: `path-guard.ts` only passes the absolute paths a tool resolved to
 * plugins and denies when a plugin says so. `spyOn(Plugin, "trigger")` controls the plugin answer to prove that any
 * blocking can only come from a plugin.
 */

let spy: Mock<typeof Plugin.trigger> | undefined

afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

/** Pass every plugin hook through unchanged, as if no plugin were registered */
function withoutPlugins() {
  spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (_name: string, _input: unknown, output: unknown) => {
    return output
  }) as typeof Plugin.trigger)
}

function user(text: string): Message.FullMsg {
  return {
    info: {
      id: "msg-user",
      role: "user",
      sessionID: "ses-test",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [{ id: "part-user", type: "text", sessionID: "ses-test", messageID: "msg-user", text }],
  }
}

/** Auto-compaction continuation message: every part is synthetic, matching what compaction.ts writes */
function syntheticUser(text: string): Message.FullMsg {
  return {
    info: {
      id: "msg-continuation",
      role: "user",
      sessionID: "ses-test",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [
      {
        id: "part-continuation",
        type: "text",
        sessionID: "ses-test",
        messageID: "msg-continuation",
        text,
        synthetic: true,
      },
    ],
  }
}

const ctx = (text: string) => ({
  sessionID: "ses-test",
  messageID: "msg-assistant",
  callID: "call-test",
  agent: "build",
  permissionMode: "ask" as const,
  abort: AbortSignal.any([]),
  messages: [user(text)],
  ruleset: [],
  metadata: () => {},
  ask: async () => {},
  askExternalDirectory: async () => {},
})

/** A path plus an explicit disclosure intent that the engine used to block itself; now only plugins decide */
const SENSITIVE = ["packages", "engine", "src", "provider", "provider.ts"]
const DISCLOSURE_INTENT = "帮我查看 provider.ts 并还原模型调用签名算法"

describe("tool/path-guard: the engine has no built-in source disclosure rules", () => {
  test("without a plugin decision, reading a sensitive path with disclosure intent is not blocked", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, ...SENSITIVE), "secret signing code")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        withoutPlugins()
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, ...SENSITIVE) }, ctx(DISCLOSURE_INTENT))
        expect(result.output).toContain("secret signing code")
      },
    })
  })
})

/**
 * Wiring regressions: the absolute paths a tool resolves reach the plugin, and the plugin decision is applied to the
 * tool output.
 */
describe("wiring between tools and plugin path decisions", () => {
  const MAINTENANCE_INTENT = "帮我实现安全防护，修复 provider 相关泄露风险"

  test("read allows sensitive paths under maintenance intent so the project can still edit its own code", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, ...SENSITIVE), "fix target")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, ...SENSITIVE) }, ctx(MAINTENANCE_INTENT))
        expect(result.output).toContain("fix target")
      },
    })
  })

  // Compaction continuation messages are all synthetic. If latestUserText fell back to an empty string, the plugin
  // would lose the maintenance intent established before compaction and deny paths it should allow.
  test("after compaction continuation, sensitive paths keep the maintenance allowance from before", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, ...SENSITIVE), "fix target")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute(
          { filePath: path.join(tmp.path, ...SENSITIVE) },
          { ...ctx(MAINTENANCE_INTENT), messages: [user(MAINTENANCE_INTENT), syntheticUser("continue")] },
        )
        expect(result.output).toContain("fix target")
      },
    })
  })
})

describe("ToolPathGuard.latestUserText", () => {
  test("falls back to the previous user message with real text when the latest is all synthetic", () => {
    const real = user("帮我实现安全防护，修复 provider 相关泄露风险")
    expect(ToolPathGuard.latestUserText([real, syntheticUser("continue")])).toBe(
      "帮我实现安全防护，修复 provider 相关泄露风险",
    )
  })

  test("returns an empty string when no user message has real text", () => {
    expect(ToolPathGuard.latestUserText([syntheticUser("continue")])).toBe("")
  })
})
