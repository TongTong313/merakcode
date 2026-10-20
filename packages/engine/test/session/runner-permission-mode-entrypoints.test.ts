import { test, expect } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/session/index"
import { SessionRunner } from "@merakcode/engine/session/runner"

test("command input accepts permissionMode=auto", () => {
  expect(
    SessionRunner.CommandInput.parse({
      sessionID: "ses_command_auto",
      command: "loop",
      arguments: "check",
      permissionMode: "auto",
    }).permissionMode,
  ).toBe("auto")
})

test("shell input persists permissionMode=auto on the synthetic user message", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await SessionRunner.shell({
        sessionID: session.id,
        agent: "build",
        permissionMode: "auto",
        model: { providerID: "openai", modelID: "gpt-4" },
        command: "echo auto",
      })

      const messages = await Session.messages({ sessionID: session.id })
      const user = messages.find((msg) => msg.info.role === "user")
      if (user?.info.role !== "user") throw new Error("expected stored user message")
      expect(user.info.permissionMode).toBe("auto")
    },
  })
})
