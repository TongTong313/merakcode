import { afterEach, describe, expect, test, type Mock, vi } from "vitest"
import { Identifier } from "@merakcode/util/id"
import { Plugin } from "@merakcode/engine/agent/plugin/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { SessionProcessor } from "@merakcode/engine/agent/loop/processor"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

/**
 * Outbound review hook `experimental.message.complete.transform`, run once the whole message is final.
 *
 * 1. It receives the full text joined across parts. `experimental.text.complete` fires per text part and cannot catch
 *    output where each part is fine but the joined text is not, which is why that hook can't be reused here.
 * 2. It transforms the text rather than blocking: a review plugin replaces violating output with a safe refusal
 *    instead of aborting the turn.
 */

let spy: Mock<typeof Plugin.trigger> | undefined

afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

/** Create an assistant message with the given text parts, as it looks just before streaming finishes */
async function seedAssistant(sessionID: string, cwd: string, texts: string[]) {
  const message = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd, root: cwd },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "gpt-4",
    providerID: "openai",
    parentID: sessionID,
    time: { created: Date.now() },
  })
  const parts = []
  for (const text of texts) {
    parts.push(
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: message.id,
        sessionID,
        type: "text",
        text,
        time: { start: Date.now(), end: Date.now() },
      }),
    )
  }
  return { messageID: message.id, parts }
}

async function textsOf(sessionID: string, messageID: string) {
  const messages = await Session.messages({ sessionID })
  const target = messages.find((m) => m.info.id === messageID)
  return (target?.parts.filter((p) => p.type === "text") ?? []).map((p) => (p as { text: string }).text)
}

describe("experimental.message.complete.transform", () => {
  test("the hook receives the full text joined across text parts", async () => {
    Log.init({ print: false })
    let seen: { text?: string; final?: boolean; messageID?: string } = {}
    spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (name: string, input: unknown, output: unknown) => {
      if (name === "experimental.message.complete.transform") {
        seen = { ...(input as { messageID: string; final: boolean }), text: (output as { text: string }).text }
      }
      return output
    }) as typeof Plugin.trigger)

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "maf-out" })
        // Each part is harmless on its own; only the joined sentence needs review
        const { messageID } = await seedAssistant(session.id, tmp.path, ["前半段", "中间", "后半段"])
        await SessionProcessor.finalizeAssistantText({ sessionID: session.id, messageID })

        expect(seen.text).toBe("前半段中间后半段")
        expect(seen.messageID).toBe(messageID)
        expect(seen.final).toBe(true)
      },
    })
  })

  test("rewritten text becomes the final message: original parts are cleared and the rewrite is stored", async () => {
    Log.init({ print: false })
    spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (name: string, _input: unknown, output: unknown) => {
      if (name === "experimental.message.complete.transform") {
        ;(output as { text: string }).text = "⚠️ 已被拦截"
      }
      return output
    }) as typeof Plugin.trigger)

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "maf-out-block" })
        const { messageID } = await seedAssistant(session.id, tmp.path, ["违规内容 A", "违规内容 B"])
        await SessionProcessor.finalizeAssistantText({ sessionID: session.id, messageID })

        const texts = await textsOf(session.id, messageID)
        // Nothing of the original may remain; a leftover fragment is itself a leak
        expect(texts.join("")).not.toContain("违规内容")
        expect(texts.join("")).toContain("已被拦截")
      },
    })
  })

  test("without a rewrite the final text and part structure stay unchanged", async () => {
    Log.init({ print: false })
    spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (_n: string, _i: unknown, output: unknown) => {
      return output
    }) as typeof Plugin.trigger)

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "transform-noop" })
        const { messageID } = await seedAssistant(session.id, tmp.path, ["正常回答的", "两个片段"])
        await SessionProcessor.finalizeAssistantText({ sessionID: session.id, messageID })

        expect(await textsOf(session.id, messageID)).toEqual(["正常回答的", "两个片段"])
      },
    })
  })

  test("does not trigger the hook when there are no text parts", async () => {
    Log.init({ print: false })
    let triggered = false
    spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (name: string, _i: unknown, output: unknown) => {
      if (name === "experimental.message.complete.transform") triggered = true
      return output
    }) as typeof Plugin.trigger)

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "maf-out-empty" })
        const { messageID } = await seedAssistant(session.id, tmp.path, [])
        await SessionProcessor.finalizeAssistantText({ sessionID: session.id, messageID })
        expect(triggered).toBe(false)
      },
    })
  })
})
