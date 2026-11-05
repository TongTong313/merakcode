import { expect, test } from "vitest"
import { Session } from "../../src/agent/session"
import { SessionPlan } from "../../src/agent/session/plan"
import { Loop } from "../../src/agent/loop"
import { Instance } from "../../src/infra/project/instance"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { fakeModel } from "../../../sdk/js/test/fixture/model"
import fs from "node:fs/promises"
import path from "node:path"
import { BashJobStore } from "../../src/agent/tools/bash-background"

test.each(["chat", "button", "failed-chat", "failed-button"] as const)(
  "queued discussions do not prevent a new plan execution from %s",
  async (entry) => {
    const failed = entry.startsWith("failed-")
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const requests: { prompt: string; input: string }[] = []
    const model = await fakeModel(async (turn) => {
      requests.push({ prompt: turn.prompt, input: JSON.stringify(turn.request) })
      if (requests.length === 1) {
        entered.resolve()
        await release.promise
        if (failed) return { status: 400, message: "Execution request failed" }
      }
      return { text: "Completed the requested turn" }
    })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "fixture/large",
          small_model: "fixture/large",
          enabled_providers: ["fixture"],
          provider: {
            fixture: {
              name: "Fixture",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              options: { apiKey: "fake", baseURL: model.url },
              models: { large: { name: "Large", tool_call: true, limit: { context: 400000, output: 1000 } } },
            },
          },
          memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
          lsp: false,
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
          await SessionPlan.save({
            sessionID: session.id,
            source: "human",
            content: "EXECUTION_A_ONLY",
            expectedRevision: 0,
          })
          const start = () =>
            entry.endsWith("button")
              ? Loop.startPlan(session.id)
              : Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text: "开始执行" }] })
          const execution = start()
          try {
            await entered.promise
            const first = await SessionPlan.get(session.id)
            expect(first.status).toBe("executing")
            await SessionPlan.save({
              sessionID: session.id,
              source: "human",
              content: "EDITABLE_B_ONLY",
              expectedRevision: 1,
            })
            const discussions = ["解释最新计划，不要再次执行", "继续讨论计划，不要执行"].map((text) =>
              Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text }] }),
            )
            await expect
              .poll(
                async () =>
                  (await Session.messages({ sessionID: session.id })).filter((message) => message.info.role === "user")
                    .length,
              )
              .toBe(3)
            release.resolve()
            const results = await Promise.all([execution, ...discussions])
            for (const [index, result] of results.entries()) {
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                if (index === 0 && failed) expect(result.info.error).toBeDefined()
                else expect(result.info.error).toBeUndefined()
              }
            }
            expect((await SessionPlan.get(session.id)).status).toBe(failed ? "failed" : "completed")
            expect(requests).toHaveLength(3)
            await start()
            const second = await SessionPlan.get(session.id)
            expect(requests).toHaveLength(4)
            expect(second.status).toBe("completed")
            expect(second.execution?.id).not.toBe(first.execution?.id)
            expect(second.execution?.content).toBe("EDITABLE_B_ONLY")
            expect(requests.at(-1)?.input).toContain("EDITABLE_B_ONLY")
            expect(requests.at(-1)?.input).not.toContain("EXECUTION_A_ONLY")
          } finally {
            release.resolve()
            await execution.catch(() => {})
          }
        },
      })
    } finally {
      release.resolve()
      await Instance.disposeAll()
      await model.close()
    }
  },
  30000,
)

test.each(["same", "latest", "file", "historical", "answer", "child", "grep", "grep-active"] as const)(
  "a paused plan discussion uses the intended document for %s",
  async (view) => {
    const prompt = view === "historical" ? "解释原执行的第二步，不要继续执行" : "解释最新计划第二步，不要继续执行"
    const original = "# Plan A\nORIGINAL_A_ONLY\n1. Inspect input\n2. Write output"
    const latest = "# Plan B\nLATEST_B_ONLY\n1. Inspect changed input\n2. Write changed output"
    let executionID = ""
    let planPath = ""
    const requests: string[] = []
    const childRequests: string[] = []
    const model = await fakeModel((turn) => {
      if (turn.prompt.includes("CHILD_DISCUSSION")) {
        childRequests.push(JSON.stringify(turn.request))
        return turn.results.length
          ? { text: "Child read the latest plan" }
          : { tool: "read", args: { filePath: planPath } }
      }
      if (turn.prompt === prompt) requests.push(JSON.stringify(turn.request))
      return turn.results.length || view === "answer"
        ? { text: "The second step writes the reviewed output." }
        : view === "child"
          ? {
              tool: "subagent",
              args: {
                description: "Inspect latest plan",
                subagent_type: "explore",
                prompt: "CHILD_DISCUSSION: read the latest plan and explain step 2",
              },
            }
          : view === "grep" || view === "grep-active"
            ? { tool: "grep", args: { path: planPath, pattern: "ONLY" } }
            : view === "file"
              ? { tool: "read", args: { filePath: planPath } }
              : {
                  tool: "plan_read_chunk",
                  args: { offset: 0, limit: 1000, ...(view === "historical" ? { executionID } : {}) },
                }
    })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "fixture/large",
          small_model: "fixture/large",
          enabled_providers: ["fixture"],
          provider: {
            fixture: {
              name: "Fixture",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              options: { apiKey: "fake", baseURL: model.url },
              models: { large: { name: "Large", tool_call: true, limit: { context: 400000, output: 1000 } } },
            },
          },
          agent: { build: { deferTools: [] } },
          memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
          lsp: false,
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Paused discussion fixture" })
          await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
          await SessionPlan.save({ sessionID: session.id, source: "human", content: original, expectedRevision: 0 })
          const started = await SessionPlan.start(session.id, "chat", 1)
          executionID = started.execution!.id
          planPath = started.path
          if (view !== "same")
            await SessionPlan.save({ sessionID: session.id, source: "human", content: latest, expectedRevision: 1 })
          if (view !== "grep-active") await SessionPlan.pause(session.id, started.execution!.id, [])
          const answer = await Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text: prompt }] })
          if (answer.info.role !== "assistant") throw new Error("Expected the discussion's assistant reply")
          expect(answer.info.error).toBeUndefined()
          expect(answer.parts.some((part) => part.type === "text" && part.text.includes("second step writes"))).toBe(
            true,
          )
          expect(requests).toHaveLength(view === "answer" ? 1 : 2)
          expect(requests.at(-1)).toContain(
            view === "same" || view === "historical" ? "ORIGINAL_A_ONLY" : "LATEST_B_ONLY",
          )
          if (view !== "same" && view !== "historical") expect(requests.at(-1)).not.toContain("ORIGINAL_A_ONLY")
          const plan = await SessionPlan.get(session.id)
          expect(plan.status).toBe(view === "grep-active" ? "executing" : "paused")
          expect(plan.execution?.id).toBe(started.execution!.id)
          expect(plan.execution?.content).toBe(original)
          expect(plan.content).toBe(view === "same" ? original : latest)
          if (view === "child") {
            expect(childRequests).toHaveLength(2)
            expect(childRequests.at(-1)).toContain("LATEST_B_ONLY")
            expect(childRequests.at(-1)).not.toContain("ORIGINAL_A_ONLY")
          }
        },
      })
    } finally {
      await Instance.disposeAll()
      await model.close()
    }
  },
  30000,
)

test.each([false, true])(
  "a background completion preserves the execution outcome, foreground failed=%s",
  async (failed) => {
    const notifications: string[] = []
    const model = await fakeModel((turn) => {
      if (turn.prompt === "开始执行") return { text: "Retry completed" }
      if (turn.prompt === "解释最新计划，不要执行") return { text: "Explained the latest plan" }
      if (turn.prompt.includes("[Background bash job")) {
        notifications.push(JSON.stringify(turn.request))
        return notifications.length === 1
          ? { tool: "plan_read_chunk", args: { offset: 0, limit: 1000 } }
          : { text: "Background handled" }
      }
      return turn.results.length
        ? failed
          ? { status: 400, message: "Execution request failed" }
          : { text: "Waiting for background completion" }
        : {
            tool: "bash_background",
            args: {
              command: `"${process.execPath.replaceAll("\\", "/")}" background.mjs`,
              description: "Wait for release",
            },
          }
    })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "fixture/large",
          small_model: "fixture/large",
          enabled_providers: ["fixture"],
          provider: {
            fixture: {
              name: "Fixture",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              options: { apiKey: "fake", baseURL: model.url },
              models: { large: { name: "Large", tool_call: true, limit: { context: 400000, output: 1000 } } },
            },
          },
          agent: { build: { deferTools: [] } },
          memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
          lsp: false,
        },
      })
      await fs.writeFile(
        path.join(tmp.path, "background.mjs"),
        'import fs from "node:fs"; while(!fs.existsSync("release")) await new Promise(r=>setTimeout(r,10));',
      )
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Background snapshot fixture" })
          await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
          await SessionPlan.save({
            sessionID: session.id,
            source: "human",
            content: "BACKGROUND_A_ONLY",
            expectedRevision: 0,
          })
          try {
            const answer = await Loop.startPlan(session.id)
            if (answer.info.role !== "assistant") throw new Error("Expected an execution answer")
            if (failed) expect(answer.info.error).toBeDefined()
            else expect(answer.info.error).toBeUndefined()
            const started = await SessionPlan.get(session.id)
            expect(started.status).toBe("executing")
            await SessionPlan.save({
              sessionID: session.id,
              source: "human",
              content: "BACKGROUND_B_ONLY",
              expectedRevision: 1,
            })
            await Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text: "解释最新计划，不要执行" }] })
            expect((await SessionPlan.get(session.id)).status).toBe("executing")
            expect((await SessionPlan.get(session.id)).execution?.id).toBe(started.execution?.id)
            await fs.writeFile(path.join(tmp.path, "release"), "release")
            await expect
              .poll(async () => (await SessionPlan.get(session.id)).status, { timeout: 10000 })
              .toBe(failed ? "failed" : "completed")
            expect(notifications).toHaveLength(2)
            for (const request of notifications) {
              expect(request).toContain("BACKGROUND_A_ONLY")
              expect(request).not.toContain("BACKGROUND_B_ONLY")
            }
            const plan = await SessionPlan.get(session.id)
            expect(plan.execution?.id).toBe(started.execution?.id)
            expect(plan.execution?.content).toBe("BACKGROUND_A_ONLY")
            expect(plan.content).toBe("BACKGROUND_B_ONLY")
            expect(plan.buttonLocked).toBe(false)
            if (failed) {
              await Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text: "开始执行" }] })
              const retried = await SessionPlan.get(session.id)
              expect(retried.status).toBe("completed")
              expect(retried.execution?.id).not.toBe(started.execution?.id)
            }
          } finally {
            await BashJobStore.stopAll()
          }
        },
      })
    } finally {
      await Instance.disposeAll()
      await model.close()
    }
  },
  30000,
)
