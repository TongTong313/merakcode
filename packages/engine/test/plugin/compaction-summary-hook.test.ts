import { afterEach, describe, expect, test, type Mock, vi } from "vitest"
import { Identifier } from "@merakcode/util/id"
import { Plugin } from "@merakcode/engine/plugin/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { SessionCompaction } from "@merakcode/engine/session/compaction"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

/**
 * Output-side hook for compaction summaries.
 *
 * `experimental.compaction.messages.transform` filters the messages fed to the summary model; this hook filters the
 * summary it produces. Both are needed: the model may restate internal details from ordinary messages that never
 * touched a sensitive path, and only the output side can catch that.
 *
 * It fires after the summary is stored and the built-in `redactSummaryText` has run, so plugins can only redact
 * further and never restore what the built-in step removed.
 */

let spy: Mock<typeof Plugin.trigger> | undefined

afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

/** Create an assistant message with one text part, standing in for a freshly generated summary */
async function seedSummary(sessionID: string, cwd: string, text: string) {
  const message = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    mode: "default",
    agent: "default",
    path: { cwd, root: cwd },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "gpt-4",
    providerID: "openai",
    parentID: sessionID,
    time: { created: Date.now() },
    finish: "stop",
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID,
    type: "text",
    text,
  })
  return message.id
}

async function summaryTextOf(sessionID: string, messageID: string) {
  const messages = await Session.messages({ sessionID })
  const target = messages.find((m) => m.info.id === messageID)
  return target?.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text) ?? []
}

describe("experimental.compaction.summary.transform", () => {
  test("a plugin can redact the final summary further after redactSummaryText", async () => {
    Log.init({ print: false })
    spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (name: string, _input: unknown, output: unknown) => {
      if (name === "experimental.compaction.summary.transform") {
        const typed = output as { summary: string }
        typed.summary = typed.summary.replaceAll("内部细节", "[插件已脱敏]")
      }
      return output
    }) as typeof Plugin.trigger)

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ parentID: undefined, title: "h16" })
        const messageID = await seedSummary(session.id, tmp.path, "这里提到了内部细节，需要被脱敏")

        await SessionCompaction.redactCompactionSummary({ sessionID: session.id, messageID })

        const texts = await summaryTextOf(session.id, messageID)
        expect(texts.join("\n")).toContain("[插件已脱敏]")
        expect(texts.join("\n")).not.toContain("内部细节")
      },
    })
  })

  test("without the hook the summary is kept as is", async () => {
    Log.init({ print: false })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ parentID: undefined, title: "h16-noop" })
        const original = "一段完全正常的摘要文本"
        const messageID = await seedSummary(session.id, tmp.path, original)

        await SessionCompaction.redactCompactionSummary({ sessionID: session.id, messageID })

        expect((await summaryTextOf(session.id, messageID)).join("\n")).toBe(original)
      },
    })
  })
})
