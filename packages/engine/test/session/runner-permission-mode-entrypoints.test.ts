import { test, expect } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/agent/session/index"
import { Loop } from "@merakcode/engine/agent/loop/index"

test("command input accepts sessionMode=auto", () => {
  expect(
    Loop.CommandInput.parse({
      sessionID: "ses_command_auto",
      command: "loop",
      arguments: "check",
      sessionMode: "auto",
    }).sessionMode,
  ).toBe("auto")
})

test("shell input persists sessionMode=auto on the synthetic user message", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await Loop.shell({
        sessionID: session.id,
        agent: "build",
        sessionMode: "auto",
        model: { providerID: "openai", modelID: "gpt-4" },
        command: "echo auto",
      })

      const messages = await Session.messages({ sessionID: session.id })
      const user = messages.find((msg) => msg.info.role === "user")
      if (user?.info.role !== "user") throw new Error("expected stored user message")
      expect(user.info.sessionMode).toBe("auto")
    },
  })
})

test("legacy ask shell input explicitly leaves plan for execute", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await Session.setMode({ sessionID: session.id, sessionMode: "plan" })
      await Loop.shell({
        sessionID: session.id,
        agent: "build",
        permissionMode: "ask",
        model: { providerID: "openai", modelID: "gpt-4" },
        command: "echo legacy",
      })
      expect((await Session.get(session.id)).sessionMode).toBe("execute")
    },
  })
})
