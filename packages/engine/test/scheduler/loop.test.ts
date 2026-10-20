import { test, expect } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/session/index"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { CronCreateTool } from "@merakcode/engine/tool/loop"
import { LoopScheduler } from "@merakcode/engine/scheduler/loop/index"
import type { Tool } from "@merakcode/engine/tool/tool"
import type { Message } from "@merakcode/engine/session/message"
import { setTimeout as delay } from "node:timers/promises"

test("CronCreate: a loop task created in auto mode still passes permissionMode=auto when it runs", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const calls: SessionRunner.PromptInput[] = []
      const original = SessionRunner.prompt
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async (input) => {
        calls.push(input)
        return {
          info: {
            id: "msg_loop_prompt_stub",
            role: "assistant",
            sessionID: session.id,
            time: { created: Date.now() },
          },
          parts: [],
        } as unknown as Message.FullMsg
      }) as typeof SessionRunner.prompt

      try {
        const tool = await CronCreateTool.init()
        const result = await tool.execute({ interval: 60_000, prompt: "run scheduled task" }, {
          sessionID: session.id,
          messageID: "msg_loop_create",
          callID: "call_loop_create",
          agent: "build",
          permissionMode: "auto",
          kind: "auto",
          abort: new AbortController().signal,
          extra: { model: { providerID: "openai", modelID: "gpt-4" } },
          messages: [],
          ruleset: [],
          metadata: async () => {},
          ask: async () => {},
        } satisfies Tool.Context)

        const id = result.metadata.id
        expect(LoopScheduler.list(session.id).find((task) => task.id === id)?.permissionMode).toBe("auto")

        // Trigger a real run. The task above cannot be awaited: creation does not run it immediately (timer setup
        // and crash recovery share one arm path, and running immediately would replay old tasks after a restart),
        // and the tool enforces interval >= 60s. So create a short-interval task through the scheduler API, let
        // setInterval fire once, and cover the tick → SessionRunner.prompt context pass-through.
        const fastID = await LoopScheduler.create({
          interval: 50,
          prompt: "run scheduled task",
          sessionID: session.id,
          agent: "build",
          permissionMode: "auto",
          model: { providerID: "openai", modelID: "gpt-4" },
        })
        try {
          for (let i = 0; i < 100 && calls.length === 0; i++) {
            await delay(10)
          }
          expect(calls.length).toBeGreaterThanOrEqual(1)
          expect(calls[0].agent).toBe("build")
          expect(calls[0].permissionMode).toBe("auto")
          expect(calls[0].model).toEqual({ providerID: "openai", modelID: "gpt-4" })
        } finally {
          await LoopScheduler.remove(fastID)
        }
      } finally {
        ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = original
      }
    },
  })
})
