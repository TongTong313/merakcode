import fs from "node:fs/promises"
import path from "node:path"
import { once } from "node:events"
import { expect, test } from "vitest"
import { Session } from "../../src/agent/session"
import { SessionPlan } from "../../src/agent/session/plan"
import { Loop } from "../../src/agent/loop"
import { Instance } from "../../src/infra/project/instance"
import { BashJobStore } from "../../src/agent/tools/bash-background"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { fakeModel } from "../../../sdk/js/test/fixture/model"
import { WorkflowState } from "../../src/app/task/workflow/state"
import { Runtime } from "@merakcode/util/runtime"
import { decideExternal, runExternal } from "../../src/agent/external/runtime"
import { ModeOperations } from "../../src/agent/permission/operations"
import { execFileSync } from "node:child_process"
import { WindowsSandbox } from "../../src/infra/sandbox/windows"

test.each([
  "bash",
  "workflow",
  "external",
  "unconfirmed",
  "foreground",
  ...(process.platform === "win32" ? ["failed-stop"] : []),
])(
  "a capacity pause confirms %s termination before reporting paused",
  async (kind) => {
    const received: string[] = []
    const model = await fakeModel((turn) => {
      received.push(JSON.stringify(turn.request))
      if (turn.prompt.includes("Keep the controlled child running") && turn.results.length === 0)
        return {
          tool: "bash",
          args: {
            command: `"${process.execPath.replaceAll("\\", "/")}" background.mjs`,
            description: "Keep child running",
          },
        }
      if (turn.prompt === "开始执行" && turn.results.length === 0) {
        if (kind === "workflow")
          return {
            tool: "workflow_run",
            args: {
              script: `export const meta = {name:'Pause fixture',description:'Run a controlled child'}\nawait agent('Keep the controlled child running', {agent:'build'})`,
            },
          }
        return {
          tool: kind === "foreground" ? "bash" : "bash_background",
          args: {
            command:
              kind === "failed-stop"
                ? `./stop-receipt.exe "${process.execPath}"`
                : `"${process.execPath.replaceAll("\\", "/")}" background.mjs`,
            description: "Keep execution active",
          },
        }
      }
      return { text: "DONE" }
    })
    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (directory) => {
          if (kind === "failed-stop")
            execFileSync(
              WindowsSandbox.compiler()!,
              [
                "/nologo",
                `/out:${path.join(directory, "stop-receipt.exe")}`,
                path.join(import.meta.dirname, "../tool/fixture/stop-receipt.cs"),
              ],
              { windowsHide: true, timeout: 5000 },
            )
          await fs.writeFile(
            path.join(directory, "background.mjs"),
            `import fs from "node:fs"
fs.writeFileSync("ready", "ready")
while (!fs.existsSync("release")) await new Promise(resolve => setTimeout(resolve, 10))
fs.writeFileSync("changed-after-pause", "changed")
setInterval(()=>{},1000)`,
          )
        },
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
              models: {
                large: { name: "Large", tool_call: true, limit: { context: 400000, output: 1000 } },
                small: { name: "Small", tool_call: true, limit: { context: 30000, output: 1000 } },
              },
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
          const session = await Session.create({ title: "Resume fixture" })
          await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
          const content = "SNAPSHOT_A_" + "a".repeat(104000) + "_END_A"
          await SessionPlan.save({ sessionID: session.id, source: "human", content, expectedRevision: 0 })
          const externalAbort = new AbortController()
          let external: ReturnType<typeof runExternal> | undefined
          let externalPID = 0
          const settlement = Promise.withResolvers<void>()
          const delayedAbort = new AbortController()
          let unregisterDelayed = () => {}
          let foreground: ReturnType<typeof Loop.prompt> | undefined
          try {
            const initial = Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text: "开始执行" }] })
            if (kind === "foreground") {
              foreground = initial
              initial.catch(() => {})
            } else await initial
            expect(
              (await Session.messages({ sessionID: session.id })).flatMap((message) =>
                message.parts.filter((part) => part.type === "tool" && part.state.status === "error"),
              ),
            ).toEqual([])
            await expect
              .poll(
                async () => ({
                  ready: await fs.access(path.join(tmp.path, "ready")).then(
                    () => true,
                    () => false,
                  ),
                  workflows: await WorkflowState.listRuns(session.id),
                }),
                { timeout: 10000 },
              )
              .toMatchObject({ ready: true })
            const started = await SessionPlan.get(session.id)
            expect(started.status).toBe("executing")
            if (kind === "failed-stop")
              await expect
                .poll(() => fs.readFile(path.join(tmp.path, "stop-child.pid"), "utf8").catch(() => ""))
                .not.toBe("")
            if (kind === "external" || kind === "unconfirmed") {
              external = runExternal({
                runID: "paused-external",
                sessionID: session.id,
                launch: [
                  process.execPath,
                  ...Runtime.execArgv(),
                  path.join(import.meta.dirname, "../collaboration/fixture/operation-adapter.ts"),
                ],
                product: { id: "operations", title: "Operations" },
                task: {
                  prompt: "hold-tick",
                  cwd: tmp.path,
                  permissionLevel: "fullTakeover",
                  plan: { content, revision: started.execution!.revision!, executionID: started.execution!.id },
                },
                abort: externalAbort.signal,
                host: {
                  step: () => {},
                  question: async () => [],
                  permission: (request, operation) =>
                    decideExternal(
                      { sessionID: session.id, executionID: "paused-external", cwd: tmp.path, operation },
                      request,
                    ),
                },
              })
              external.catch(() => {})
              await expect
                .poll(() => fs.readFile(path.join(tmp.path, "effect.txt"), "utf8").catch(() => ""), { timeout: 5000 })
                .not.toBe("")
              externalPID = Number(await fs.readFile(path.join(tmp.path, "effect.txt"), "utf8"))
            }
            if (kind === "unconfirmed") {
              await WorkflowState.writeRun(session.id, "delayed-message", {
                runId: "delayed-run",
                workflowName: "Delayed receipt",
                planExecutionID: started.execution!.id,
                status: "running",
                phases: [],
                agents: [],
                logs: [],
                resumable: true,
              })
              unregisterDelayed = WorkflowState.registerRun(session.id, "delayed-run", {
                abort: delayedAbort,
                done: settlement.promise,
              })
            }
            await SessionPlan.save({
              sessionID: session.id,
              source: "human",
              content: "LATEST_EDITABLE_B",
              expectedRevision: 1,
            })
            const before = received.length
            const pausingSession =
              kind === "foreground" ? (await Session.create({ parentID: session.id })).id : session.id
            const aborted = kind === "unconfirmed" ? once(delayedAbort.signal, "abort") : undefined
            const pausing = Loop.prompt({
              sessionID: pausingSession,
              model: { providerID: "fixture", modelID: "small" },
              parts: [{ type: "text", text: "继续执行当前任务" }],
            })
            if (kind === "unconfirmed") {
              try {
                await aborted
                await external?.catch(() => {})
                expect(() => process.kill(externalPID, 0)).toThrow()
                await pausing
                expect((await SessionPlan.get(session.id)).status).toBe("executing")
                expect(() => ModeOperations.assertAvailable(session.id)).toThrow(ModeOperations.PendingError)
              } finally {
                settlement.resolve()
                await pausing
              }
              await expect.poll(async () => (await SessionPlan.get(session.id)).status).toBe("paused")
              expect(() => ModeOperations.assertAvailable(session.id)).not.toThrow()
            } else await pausing
            if (kind === "failed-stop") {
              expect((await SessionPlan.get(session.id)).status).toBe("executing")
              expect(() => ModeOperations.assertAvailable(session.id)).toThrow(ModeOperations.PendingError)
              await fs.writeFile(path.join(tmp.path, "release-stop"), "release")
            }
            expect(received).toHaveLength(before)
            await expect.poll(async () => (await SessionPlan.get(session.id)).status, { timeout: 5000 }).toBe("paused")
            if (externalPID) expect(() => process.kill(externalPID, 0)).toThrow()
            const heartbeat =
              kind === "failed-stop" ? await fs.readFile(path.join(tmp.path, "stop-heartbeat"), "utf8") : undefined
            if (kind === "failed-stop") {
              const stopPID = Number(await fs.readFile(path.join(tmp.path, "stop-child.pid"), "utf8"))
              expect(() => process.kill(stopPID, 0)).toThrow()
            }
            await fs.writeFile(path.join(tmp.path, "release"), "release")
            await new Promise((resolve) => setTimeout(resolve, 500))
            if (kind === "failed-stop")
              expect(await fs.readFile(path.join(tmp.path, "stop-heartbeat"), "utf8")).toBe(heartbeat)
            expect(await fs.readFile(path.join(tmp.path, "changed-after-pause"), "utf8").catch(() => "unchanged")).toBe(
              "unchanged",
            )
            expect(BashJobStore.running().filter((job) => job.planExecutionID === started.execution?.id)).toHaveLength(
              0,
            )
            expect((await WorkflowState.listRuns(session.id)).filter((run) => run.status === "running")).toHaveLength(0)
            expect(received).toHaveLength(before)
            expect((await SessionPlan.get(session.id)).status).toBe("paused")
          } finally {
            if (kind === "failed-stop") await fs.writeFile(path.join(tmp.path, "release-stop"), "release")
            if (foreground) {
              await Loop.cancelAndSettle(session.id)
              await foreground.catch(() => {})
            }
            settlement.resolve()
            unregisterDelayed()
            externalAbort.abort()
            await external?.catch(() => {})
            for (const run of await WorkflowState.listRuns(session.id))
              if (run.status === "running") await WorkflowState.cancelRun(session.id, run.runId)
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
