import { fakeModel } from "../../../sdk/js/test/fixture/model"
import { test, expect } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { Session } from "@merakcode/engine/agent/session/index"
import { Loop } from "@merakcode/engine/agent/loop/index"

test("command input validates the new permission level enum", () => {
  expect(
    Loop.CommandInput.parse({
      sessionID: "ses_command_auto",
      command: "loop",
      arguments: "check",
      permissionLevel: "fullTakeover",
    }).permissionLevel,
  ).toBe("fullTakeover")
})

test("shell input records the root selection without applying a stale hint", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await Loop.shell({
        sessionID: session.id,
        agent: "build",
        permissionLevel: "fullTakeover",
        model: { providerID: "openai", modelID: "gpt-4" },
        command: "echo auto",
      })

      const messages = await Session.messages({ sessionID: session.id })
      const user = messages.find((msg) => msg.info.role === "user")
      if (user?.info.role !== "user") throw new Error("expected stored user message")
      expect(user.info.permissionLevel).toBe("ask")
    },
  })
})

test("legacy shell hints do not change the selected root level", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
      await Loop.shell({
        sessionID: session.id,
        agent: "build",
        permissionMode: "ask",
        model: { providerID: "openai", modelID: "gpt-4" },
        command: "echo legacy",
      })
      expect((await Session.get(session.id)).permissionLevel).toBe("ask")
    },
  })
})

test.each(["subtask", "command"] as const)(
  "the real %s entry authorizes the parent before starting its child",
  async (entry) => {
    const model = await fakeModel((turn) => ({
      text: turn.prompt === "ENTRY_CHILD" ? "CHILD_EXECUTED" : "Root complete",
    }))
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "alibaba-cn/qwen-plus",
          small_model: "alibaba-cn/qwen-plus",
          enabled_providers: ["alibaba-cn"],
          provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
          command: { delegated: { template: "ENTRY_CHILD", subtask: true, agent: "general" } },
          memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
          lsp: false,
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
          if (entry === "command")
            await Loop.command({
              sessionID: session.id,
              command: "delegated",
              arguments: "",
              model: "alibaba-cn/qwen-plus",
            })
          else
            await Loop.prompt({
              sessionID: session.id,
              parts: [
                { type: "text", text: "Run the requested child." },
                { type: "subtask", prompt: "ENTRY_CHILD", description: "Controlled entry", agent: "general" },
              ],
            })
          expect(model.turns.some((turn) => turn.prompt === "ENTRY_CHILD")).toBe(true)
          expect(await Session.children(session.id)).toHaveLength(1)
        },
      })
    } finally {
      await Instance.disposeAll()
      await model.close()
    }
  },
  20000,
)
