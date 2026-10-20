import { afterEach, describe, expect, test, type Mock, vi } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { SessionRunner } from "@merakcode/engine/session/runner"

import { Plugin } from "@merakcode/engine/plugin/index"
import { tmpdir } from "../fixture/fixture"

/**
 * experimental.chat.guard, the whole-turn refusal hook. Session and the plugin loader are not mocked; only
 * spyOn(Plugin, "trigger") controls the plugin's answer, on the real seam between the loader and the code under test.
 *
 * Covers:
 *   1) Without a plugin, nothing changes (wiring regressions live in test/safety/guard-neutrality.test.ts and
 *      test/tool/path-guard.test.ts).
 *   2) A plugin refuse makes the runner refuse a real user message with the plugin's text.
 *   3) A plugin refuse without a message falls back to the engine's neutral text; the decision and wording belong to
 *      plugins, so the engine has no other text to fall back to.
 */

/**
 * Neutral fallback the engine uses when a plugin refuses without text (`GENERIC_REFUSAL_MESSAGE` in
 * `session/runner.ts`). Written as a literal instead of imported: it is a user-facing text contract, so changing it
 * should fail here rather than drift silently with the implementation.
 */
const GENERIC_REFUSAL_MESSAGE = "抱歉，这个请求已被安全策略拒绝。"

let spy: Mock<typeof Plugin.trigger> | undefined
afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

describe("experimental.chat.guard", () => {
  test("plugin refuse in the hook refuses a real user message with the plugin's text", async () => {
    let seenInput: { sessionID: string; agent: string; role: string } | undefined
    spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (name: string, input: unknown, output: unknown) => {
      if (name === "experimental.chat.guard") {
        seenInput = input as typeof seenInput
        const typed = output as { refuse: boolean; message: string }
        typed.refuse = true
        typed.message = "插件自定义拒绝文案"
      }
      return output
    }) as typeof Plugin.trigger)

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionRunner.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "openai", modelID: "__no_such_model_for_test__" },
          parts: [{ type: "text", text: "普通的无害请求" }],
        })
        expect(msg.info.role).toBe("assistant")
        expect(msg.parts.some((p) => p.type === "text" && p.text === "插件自定义拒绝文案")).toBe(true)
        expect(seenInput?.sessionID).toBe(session.id)
        expect(seenInput?.role).toBe("user")
        await Session.remove(session.id)
      },
    })
  })

  test("plugin refuse without a message falls back to the engine's neutral text", async () => {
    spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (name: string, _input: unknown, output: unknown) => {
      if (name === "experimental.chat.guard") {
        ;(output as { refuse: boolean; message: string }).refuse = true
      }
      return output
    }) as typeof Plugin.trigger)

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionRunner.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "openai", modelID: "__no_such_model_for_test__" },
          parts: [{ type: "text", text: "普通的无害请求" }],
        })
        expect(msg.parts.some((p) => p.type === "text" && p.text === GENERIC_REFUSAL_MESSAGE)).toBe(true)
        await Session.remove(session.id)
      },
    })
  })

  test("harmless request is not refused when no plugin registers the hook", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        let refused = false
        try {
          const msg = await SessionRunner.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "openai", modelID: "__no_such_model_for_test__" },
            parts: [{ type: "text", text: "普通的无害请求" }],
          })
          refused = msg.parts.some((p) => p.type === "text" && p.text === GENERIC_REFUSAL_MESSAGE)
        } catch {
          // Expected: past the guard, model resolution throws, so the request was not refused.
        }
        expect(refused).toBe(false)
        await Session.remove(session.id)
      },
    })
  })
})
