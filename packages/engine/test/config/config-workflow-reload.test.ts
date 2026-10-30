import { describe, expect, test } from "vitest"
import { Config } from "@merakcode/engine/app/config/files/config"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { SessionNotification } from "@merakcode/engine/agent/session/notification"
import { WorkflowState } from "@merakcode/engine/app/task/workflow/state"
import { tmpdir } from "../fixture/fixture"

/**
 * Writing project config must not abort background workflows.
 *
 * Disposing the instance right after a config write used to abort every active workflow and persist it as aborted,
 * so the main agent stopped waiting and ran ahead on its own. With active workflows the full reload is now deferred:
 * config values are invalidated immediately and the instance is disposed once no workflow is active.
 */
describe("config hot reload keeps background workflows alive", () => {
  test("active workflow is not aborted and stays running while project config is written", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "session-cfg-" + Math.random().toString(36).slice(2)
        const controller = new AbortController()
        await WorkflowState.writeRun(sid, "msg-1", {
          status: "running",
          workflowName: "demo",
          runId: "run-cfg",
          phases: [{ title: "Scan" }],
          agents: [],
          logs: [],
          resumable: true,
        })
        const unregister = WorkflowState.registerRun(sid, "run-cfg", controller)
        try {
          await Config.updateProjectMerakCode({})

          expect(controller.signal.aborted).toBe(false)
          const run = await WorkflowState.readRun(sid, "run-cfg")
          expect(run?.status).toBe("running")
          // No "aborted" completion notification was pushed
          const pending = await SessionNotification.list(sid)
          expect(pending.some((n) => n.id === `workflow_finished_${sid}_run-cfg`)).toBe(false)
        } finally {
          unregister()
        }
      },
    })
  })
})
