import { SessionOperations } from "@merakcode/engine/app/session"
import { afterEach, expect, test } from "vitest"
import path from "node:path"
import { BashBackgroundTool, BashJobStore } from "@merakcode/engine/agent/tools/bash-background"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Identifier } from "@merakcode/util/id"
import { Plugin } from "@merakcode/engine/agent/plugin/index"
import { Provider } from "@merakcode/engine/agent/model/provider"
import { Session } from "@merakcode/engine/agent/session/index"
import { Message } from "@merakcode/engine/agent/session/message"
import { LoopExecution } from "@merakcode/engine/agent/loop/execution"
import { Shell } from "@merakcode/engine/infra/process/shell/shell"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { setTimeout as delay } from "node:timers/promises"

const originalTrigger = Plugin.trigger
const originalModel = Provider.getModel
afterEach(() => {
  BashJobStore.clear()
  Plugin.trigger = originalTrigger
  Provider.getModel = originalModel
})

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await check()) return true
    await delay(10)
  }
  return check()
}

for (const outcome of ["finished", "cancelled"] as const) {
  test(`background process completion starts a fresh notification after its request is ${outcome}`, async () => {
    Provider.getModel = (async () => ({
      id: "test-model",
      providerID: "test",
      api: { id: "test-model", npm: "@ai-sdk/openai-compatible", url: "https://example.invalid" },
      limit: { context: 128_000, output: 8_192 },
    })) as unknown as typeof Provider.getModel
    const promptScopes: Array<string | undefined> = []
    Plugin.trigger = (async (name, _input, output) => {
      if (name === "chat.message") promptScopes.push(LoopExecution.current()?.id)
      if (name === "experimental.chat.guard") {
        Object.assign(output as object, { refuse: true, message: "Background notification received" })
      }
      return output
    }) as typeof Plugin.trigger
    await using tmp = await tmpdir({ git: true, config: { model: "test/test-model" } })
    await Filesystem.write(
      path.join(tmp.path, "background.mjs"),
      `
import { stat } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
while (!(await stat("release-job").then((info) => info.isFile(), () => false))) await sleep(10)
console.log("background-result")
`,
    )
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Background scope regression" })
        const scope = LoopExecution.create({ id: `background-${outcome}`, sessionID: session.id })
        const tool = await BashBackgroundTool.init()
        const executable = process.execPath.replaceAll("\\", "/")
        const invoke = /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(Shell.acceptable()) ? "& " : ""
        const result = await LoopExecution.run(scope, () =>
          tool.execute(
            {
              command: `${invoke}"${executable}" background.mjs`,
              description: "Controlled background notification",
              timeout: 15_000,
            },
            {
              sessionID: session.id,
              messageID: Identifier.ascending("message"),
              callID: "background-call",
              agent: "build",
              permissionMode: "auto",
              abort: scope.controller.signal,
              messages: [],
              ruleset: [],
              metadata() {},
              async ask() {},
            },
          ),
        )
        try {
          const cancellation = outcome === "cancelled" ? LoopExecution.cancel(session.id, [scope.id]) : undefined
          LoopExecution.finish(scope)
          await cancellation
          await Filesystem.write(path.join(tmp.path, "release-job"), "release")
          const job = BashJobStore.get(result.metadata.jobId)!
          if (!(await waitFor(() => job.status === "completed"))) {
            throw new Error(
              `Background fixture did not complete: ${JSON.stringify({ status: job.status, exitCode: job.exitCode, log: job.log })}`,
            )
          }
          expect(job.exitCode).toBe(0)
          expect(await waitFor(() => promptScopes.length === 1)).toBe(true)
          expect(promptScopes).toEqual([undefined])
          expect(
            await waitFor(async () =>
              (await Message.filterCompacted(Message.stream(session.id))).some(
                (message) =>
                  message.info.role === "assistant" &&
                  message.parts.some(
                    (part) => part.type === "text" && part.text === "Background notification received",
                  ),
              ),
            ),
          ).toBe(true)
          const messages = await Message.filterCompacted(Message.stream(session.id))
          expect(messages.filter((message) => message.info.role === "user")).toHaveLength(1)
          expect(
            messages
              .flatMap((message) => message.parts)
              .some((part) => part.type === "text" && part.text.includes("background-result")),
          ).toBe(true)
        } finally {
          LoopExecution.finish(scope)
          await BashJobStore.stopAll()
          await SessionOperations.remove(session.id)
        }
      },
    })
  }, 30_000)
}
