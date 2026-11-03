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
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { setTimeout as delay } from "node:timers/promises"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { SessionPlan } from "@merakcode/engine/agent/session/plan"
import { fakeModel } from "../../../sdk/js/test/fixture/model"

const originalTrigger = Plugin.trigger
const originalModel = Provider.getModel
afterEach(() => {
  BashJobStore.clear()
  Plugin.trigger = originalTrigger
  Provider.getModel = originalModel
})

test("background notifications preserve human plan edits until a new human instruction", async () => {
  const model = await fakeModel(async (turn) => {
    if (turn.prompt.includes("[Background bash job"))
      return turn.results.length === 0
        ? { tool: "plan_generate", args: { content: "AUTOMATIC_OVERWRITE", expectedRevision: 2 } }
        : { text: "Notification handled" }
    if (turn.prompt === "Revise the plan now")
      return turn.results.length === 0
        ? { tool: "plan_generate", args: { content: "REQUESTED_REVISION", expectedRevision: 2 } }
        : { text: "Revision handled" }
    return { text: "Initial request handled" }
  })
  try {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "alibaba-cn/qwen-plus",
        small_model: "alibaba-cn/qwen-plus",
        enabled_providers: ["alibaba-cn"],
        provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
        memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
        lsp: false,
      },
    })
    await Filesystem.write(
      path.join(tmp.path, "background.mjs"),
      `import fs from "node:fs"
while (!fs.existsSync("release-job")) await new Promise(resolve => setTimeout(resolve, 10))
console.log("background-result")`,
    )
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Human plan precedence" })
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
        const initial = await Loop.prompt({
          sessionID: session.id,
          permissionLevel: "fullTakeover",
          parts: [{ type: "text", text: "Prepare a plan" }],
        })
        const plan = await SessionPlan.save({
          sessionID: session.id,
          source: "agent",
          content: "Original",
          expectedRevision: 0,
        })
        const tool = await BashBackgroundTool.init()
        await tool.execute(
          {
            command: `"${process.execPath.replaceAll("\\", "/")}" background.mjs`,
            description: "Controlled notification",
            timeout: 15_000,
          },
          {
            sessionID: session.id,
            messageID: initial.info.id,
            callID: "human-plan-notification",
            agent: "build",
            permissionLevel: "fullTakeover",
            abort: new AbortController().signal,
            messages: [],
            ruleset: [],
            metadata() {},
            async ask() {},
          },
        )
        await SessionPlan.save({
          sessionID: session.id,
          source: "human",
          content: "HUMAN_APPROVED",
          expectedRevision: plan.revision,
        })
        await Filesystem.write(path.join(tmp.path, "release-job"), "release")
        await expect
          .poll(
            async () =>
              (await Session.messages({ sessionID: session.id }))
                .flatMap((message) => message.parts)
                .some((part) => part.type === "text" && part.text === "Notification handled"),
            { timeout: 15_000 },
          )
          .toBe(true)
        expect((await SessionPlan.get(session.id)).content).toBe("HUMAN_APPROVED")
        await Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text: "Revise the plan now" }] })
        expect((await SessionPlan.get(session.id)).content).toBe("REQUESTED_REVISION")
      },
    })
  } finally {
    await BashJobStore.stopAll()
    await Instance.disposeAll()
    await model.close()
  }
}, 30_000)

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
              permissionLevel: "fullTakeover",
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

test.each([false, true])(
  "a background continuation keeps draft scope after a later implementation request (origin deleted=%s)",
  async (deleted) => {
    const model = await fakeModel(async (turn) => {
      if (turn.prompt.includes("[Background bash job"))
        return turn.results.length === 0
          ? { tool: "write", args: { filePath: "effect.txt", content: "CHANGED" } }
          : { text: "Original draft continuation complete" }
      return { text: "Initial draft complete" }
    })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "alibaba-cn/qwen-plus",
          small_model: "alibaba-cn/qwen-plus",
          enabled_providers: ["alibaba-cn"],
          provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
          memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
          lsp: false,
        },
      })
      await Filesystem.write(
        path.join(tmp.path, "background.mjs"),
        `import fs from "node:fs";while(!fs.existsSync("release-job"))await new Promise(r=>setTimeout(r,10));console.log("complete")`,
      )
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
          const initial = await Loop.prompt({
            sessionID: session.id,
            parts: [{ type: "text", text: "只出稿，不要修改项目。" }],
          })
          await (
            await BashBackgroundTool.init()
          ).execute(
            {
              command: `"${process.execPath.replaceAll("\\", "/")}" background.mjs`,
              description: "Controlled draft completion",
              timeout: 15000,
            },
            {
              sessionID: session.id,
              messageID: initial.info.id,
              callID: "draft-notification",
              agent: "build",
              permissionLevel: "fullTakeover",
              abort: new AbortController().signal,
              messages: [],
              ruleset: [],
              metadata() {},
              async ask() {},
            },
          )
          await Loop.prompt({
            sessionID: session.id,
            noReply: true,
            parts: [{ type: "text", text: "开始实施另一个任务。" }],
          })
          if (deleted) await Session.removeMessage({ sessionID: session.id, messageID: initial.info.id })
          await Filesystem.write(path.join(tmp.path, "release-job"), "release")
          await expect
            .poll(
              async () =>
                (await Session.messages({ sessionID: session.id }))
                  .flatMap((m) => m.parts)
                  .some((p) => p.type === "text" && p.text === "Original draft continuation complete"),
              { timeout: 15000 },
            )
            .toBe(true)
          const attempts = (await Session.messages({ sessionID: session.id }))
            .flatMap((m) => m.parts)
            .filter((p) => p.type === "tool" && p.tool === "write")
          expect(attempts).toHaveLength(1)
          expect(attempts[0]).toMatchObject({
            state: { status: "error", error: expect.stringMatching(/只出稿|draft-only/) },
          })
          expect(await Filesystem.exists(path.join(tmp.path, "effect.txt"))).toBe(false)
        },
      })
    } finally {
      await BashJobStore.stopAll()
      await Instance.disposeAll()
      await model.close()
    }
  },
  30000,
)
