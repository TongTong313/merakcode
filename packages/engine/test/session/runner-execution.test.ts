import { afterEach, expect, test } from "vitest"
import { Bus } from "@merakcode/engine/bus/index"
import { Command } from "@merakcode/engine/command/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Plugin } from "@merakcode/engine/plugin/index"
import { Provider } from "@merakcode/engine/provider/provider"
import { Session } from "@merakcode/engine/session/index"
import { SessionExecution } from "@merakcode/engine/session/execution"
import { LLM } from "@merakcode/engine/session/llm"
import { Message } from "@merakcode/engine/session/message"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { tmpdir } from "../fixture/fixture"

const realTrigger = Plugin.trigger
const realModel = Provider.getModel
const realStream = LLM.stream
afterEach(() => {
  Plugin.trigger = realTrigger
  Provider.getModel = realModel
  LLM.stream = realStream
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

function modelFixture() {
  Provider.getModel = (async () => ({
    id: "test-model",
    providerID: "test",
    api: { id: "test-model", npm: "@ai-sdk/openai-compatible", url: "https://example.invalid" },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, input: 128000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  })) as typeof Provider.getModel
  let calls = 0
  LLM.stream = (async () => {
    calls++
    throw new Error("Preparation tests must not invoke a model")
  }) as typeof LLM.stream
  return () => calls
}

test("cancelled command preparation drops late plugin output and leaves the legacy command path usable", async () => {
  const calls = modelFixture()
  const entered = deferred()
  const release = deferred()
  let block = true
  Plugin.trigger = (async (name, _input, output) => {
    if (name === "command.execute.before" && block) {
      entered.resolve()
      await release.promise
    }
    if (name === "experimental.chat.guard") {
      Object.assign(output as object, { refuse: true, message: "Controlled local response" })
    }
    return output
  }) as typeof Plugin.trigger
  await using tmp = await tmpdir({ git: true, config: { command: { check: { template: "Check $ARGUMENTS" } } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "Preparation cancellation" })
      let completed = 0
      const unsubscribe = Bus.subscribe(Command.Event.Executed, () => {
        completed++
      })
      const scope = SessionExecution.create({ id: "command-preparation", sessionID: session.id })
      const input = {
        sessionID: session.id,
        command: "check",
        arguments: "cancelled",
        agent: "build",
        model: "test/test-model",
      }
      const pending = SessionExecution.run(scope, () => SessionRunner.command(input)).finally(() =>
        SessionExecution.finish(scope),
      )
      void pending.catch(() => {})
      await entered.promise
      await SessionExecution.cancel(session.id, [scope.id])
      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      block = false
      release.resolve()
      await Promise.resolve()
      expect(await Message.filterCompacted(Message.stream(session.id))).toHaveLength(0)
      expect(calls()).toBe(0)
      expect(completed).toBe(0)

      const result = await SessionRunner.command({ ...input, arguments: "legacy" })
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "Controlled local response")).toBe(true)
      expect(completed).toBe(1)
      expect(calls()).toBe(0)
      unsubscribe()
      await Session.remove(session.id)
    },
  })
}, 30000)

test("cancelling after user persistence settles the user before ACK and ignores late guard refusal", async () => {
  const calls = modelFixture()
  const entered = deferred()
  const release = deferred()
  Plugin.trigger = (async (name, _input, output) => {
    if (name === "experimental.chat.guard") {
      entered.resolve()
      await release.promise
      Object.assign(output as object, { refuse: true, message: "Late refusal must be discarded" })
    }
    return output
  }) as typeof Plugin.trigger
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "Persisted cancellation" })
      const scope = SessionExecution.create({ id: "persisted-preparation", sessionID: session.id })
      const pending = SessionExecution.run(scope, () =>
        SessionRunner.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "Cancelled before the model starts" }],
        }),
      ).finally(() => SessionExecution.finish(scope))
      void pending.catch(() => {})
      await entered.promise
      await SessionExecution.cancel(session.id, [scope.id])
      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      const messages = await Message.filterCompacted(Message.stream(session.id))
      const user = messages.find((message) => message.info.role === "user")!
      const replies = messages.filter(
        (message) => message.info.role === "assistant" && message.info.parentID === user.info.id,
      )
      expect(replies).toHaveLength(1)
      expect(replies[0].info.role === "assistant" && replies[0].info.error?.name).toBe("MessageAbortedError")
      release.resolve()
      await Promise.resolve()
      expect(calls()).toBe(0)
      expect(
        (await Message.filterCompacted(Message.stream(session.id)))
          .flatMap((message) => message.parts)
          .some((part) => part.type === "text" && part.text === "Late refusal must be discarded"),
      ).toBe(false)
      await Session.remove(session.id)
    },
  })
}, 30000)

test("command writes the mode it carries back to the session", async () => {
  modelFixture()
  Plugin.trigger = (async (name, _input, output) => {
    if (name === "experimental.chat.guard") Object.assign(output as object, { refuse: true, message: "Done" })
    return output
  }) as typeof Plugin.trigger
  await using tmp = await tmpdir({ git: true, config: { command: { check: { template: "Check" } } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "Command mode" })
      await Session.update(session.id, (draft) => {
        draft.permissionMode = "auto"
      })
      await SessionRunner.command({
        sessionID: session.id,
        command: "check",
        arguments: "",
        agent: "build",
        model: "test/test-model",
        permissionMode: "ask",
      })
      expect((await Session.get(session.id)).permissionMode).toBe("ask")
      await Session.remove(session.id)
    },
  })
}, 30000)
