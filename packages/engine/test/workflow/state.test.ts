import { describe, expect, test } from "vitest"
import { Bus } from "@merakcode/engine/bus/index"
import { Instance } from "@merakcode/engine/project/instance"
import { SessionNotification } from "@merakcode/engine/session/notification"
import { WorkflowState } from "@merakcode/engine/workflow/state"
import type { WorkflowRunCache } from "@merakcode/engine/workflow/types"
import { tmpdir } from "../fixture/fixture"

describe("WorkflowState", () => {
  test("stores workflow run records and publishes updates", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Storage is a process-wide singleton under Global.Path.data, so listRuns sees leftovers from other tests.
        // A unique sessionID isolates this run.
        const sid = "session-store-" + Math.random().toString(36).slice(2)
        const events: string[] = []
        const unsub = Bus.subscribe(WorkflowState.Event.Updated, (event) => {
          events.push(event.properties.runId)
        })
        try {
          await WorkflowState.writeRun(sid, "message-test", {
            status: "completed",
            workflowName: "demo",
            runId: "run-test",
            phases: [{ title: "Scan" }],
            agents: [],
            logs: [],
            resumable: true,
          })

          const runs = await WorkflowState.listRuns(sid)
          expect(runs).toHaveLength(1)
          expect(runs[0]?.workflowName).toBe("demo")
          expect(runs[0]?.messageID).toBe("message-test")
          expect(events).toEqual(["run-test"])
        } finally {
          unsub()
        }
      },
    })
  })

  test("updates workflow run records atomically", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const events: string[] = []
        const unsub = Bus.subscribe(WorkflowState.Event.Updated, (event) => {
          events.push(event.properties.runId)
        })
        try {
          await WorkflowState.writeRun("session-test", "message-test", {
            status: "running",
            workflowName: "demo",
            runId: "run-test",
            phases: [{ title: "Scan" }],
            agents: [],
            logs: [],
            resumable: true,
            runningAgentCount: 1,
          })
          await WorkflowState.updateRun("session-test", "run-test", (draft) => {
            draft.failedAgentCount = 1
          })

          const run = await WorkflowState.readRun("session-test", "run-test")
          expect(run?.failedAgentCount).toBe(1)
          expect(run?.runningAgentCount).toBe(1)
          expect(events).toEqual(["run-test", "run-test"])
        } finally {
          unsub()
        }
      },
    })
  })

  test("registers and cancels active workflow runs", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const controller = new AbortController()
        const unregister = WorkflowState.registerRun("session-test", "run-test", controller)

        expect(await WorkflowState.cancelRun("session-test", "run-test")).toBe(true)
        expect(controller.signal.aborted).toBe(true)
        expect(await WorkflowState.cancelRun("session-test", "run-test")).toBe(false)

        unregister()
      },
    })
  })

  test("unregistering active workflow runs removes cancel handles", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const controller = new AbortController()
        const unregister = WorkflowState.registerRun("session-test", "run-test", controller)

        unregister()

        expect(await WorkflowState.cancelRun("session-test", "run-test")).toBe(false)
        expect(controller.signal.aborted).toBe(false)
      },
    })
  })

  test("writes and reads the resume cache round-trip", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cache: WorkflowRunCache = {
          version: 1,
          runId: "run-cache",
          workflowName: "demo",
          entries: [
            {
              hash: "abc",
              result: { ok: true },
              agent: {
                id: "agent-1",
                label: "scan",
                agent: "workflow-subagent",
                status: "completed",
              },
            },
          ],
        }
        await WorkflowState.write("session-test", cache)
        const read = await WorkflowState.read("session-test", "run-cache")
        expect(read).toEqual(cache)
        expect(read?.entries[0]?.result).toEqual({ ok: true })
      },
    })
  })

  test("read returns undefined for a missing cache entry", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await WorkflowState.read("session-test", "missing-run")
        expect(read).toBeUndefined()
      },
    })
  })

  test("listRuns orders runs by updatedAt descending", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const base = {
          status: "completed" as const,
          workflowName: "demo",
          phases: [{ title: "Scan" }],
          agents: [],
          logs: [],
          resumable: true,
        }
        // A unique sessionID isolates leftovers in the global Storage. updatedAt is passed to writeRun directly
        // because updateRun always overwrites it with Date.now().
        const sid = "session-order-" + Math.random().toString(36).slice(2)
        await WorkflowState.writeRun(sid, "msg-1", { ...base, runId: "run-old", updatedAt: 1000 })
        await WorkflowState.writeRun(sid, "msg-2", { ...base, runId: "run-new", updatedAt: 2000 })

        const runs = await WorkflowState.listRuns(sid)
        expect(runs.map((run) => run.runId)).toEqual(["run-new", "run-old"])
      },
    })
  })

  test("dispose marks active runs aborted so resume shows the correct terminal state", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "session-dispose-" + Math.random().toString(36).slice(2)
        const controller = new AbortController()
        await WorkflowState.writeRun(sid, "msg-1", {
          status: "running",
          workflowName: "demo",
          runId: "run-x",
          phases: [{ title: "Scan" }],
          agents: [],
          logs: [],
          resumable: true,
        })
        WorkflowState.registerRun(sid, "run-x", controller)

        // Simulates the process or instance exiting
        await Instance.dispose()

        // After resume the run reads as aborted, not a leftover running
        const run = await WorkflowState.readRun(sid, "run-x")
        expect(run?.status).toBe("aborted")
        expect(run?.completedAt).toBeDefined()
        expect(controller.signal.aborted).toBe(true)
      },
    })
  })

  test("dispose does not overwrite runs that already reached a terminal state", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "session-terminal-" + Math.random().toString(36).slice(2)
        await WorkflowState.writeRun(sid, "msg-1", {
          status: "completed",
          workflowName: "demo",
          runId: "run-done",
          phases: [{ title: "Scan" }],
          agents: [],
          logs: [],
          resumable: true,
        })
        WorkflowState.registerRun(sid, "run-done", new AbortController())

        await Instance.dispose()

        const run = await WorkflowState.readRun(sid, "run-done")
        expect(run?.status).toBe("completed")
      },
    })
  })

  test("listRuns reconciles stale running runs to aborted on session resume", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "session-stale-" + Math.random().toString(36).slice(2)
        // A zombie run left by a killed process: persisted as running but absent from this process's active table
        await WorkflowState.writeRun(sid, "msg-1", {
          status: "running",
          workflowName: "demo",
          runId: "run-zombie",
          phases: [{ title: "Scan" }],
          agents: [],
          logs: [],
          resumable: true,
        })

        // The first listRuns after resuming the session corrects the zombie run to aborted
        const runs = await WorkflowState.listRuns(sid)
        expect(runs[0]?.status).toBe("aborted")
        expect(runs[0]?.completedAt).toBeDefined()

        // A run already in a terminal state is left alone
        const again = await WorkflowState.listRuns(sid)
        expect(again[0]?.status).toBe("aborted")
      },
    })
  })

  test("listRuns does not abort a run that is actively running in this process", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "session-active-" + Math.random().toString(36).slice(2)
        await WorkflowState.writeRun(sid, "msg-1", {
          status: "running",
          workflowName: "demo",
          runId: "run-live",
          phases: [{ title: "Scan" }],
          agents: [],
          logs: [],
          resumable: true,
        })
        WorkflowState.registerRun(sid, "run-live", new AbortController())

        // Repeated listRuns while running (like TUI polling) must not mark the run aborted
        for (let i = 0; i < 3; i++) {
          const runs = await WorkflowState.listRuns(sid)
          expect(runs[0]?.status).toBe("running")
        }
      },
    })
  })

  test("listRuns does not abort a run that is still registered in this process", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "session-active-" + Math.random().toString(36).slice(2)
        const controller = new AbortController()
        WorkflowState.registerRun(sid, "run-active", controller)
        await WorkflowState.writeRun(sid, "msg-1", {
          status: "running",
          workflowName: "demo",
          runId: "run-active",
          phases: [{ title: "Scan" }],
          agents: [],
          logs: [],
          resumable: true,
        })

        // Repeated listRuns while running must not reconcile the run to aborted
        for (let i = 0; i < 3; i++) {
          const runs = await WorkflowState.listRuns(sid)
          expect(runs[0]?.status).toBe("running")
        }
        expect(controller.signal.aborted).toBe(false)
      },
    })
  })

  test("cancel synchronously marks aborted and enqueues the finished notification", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "session-cancel-" + Math.random().toString(36).slice(2)
        const controller = new AbortController()
        let notified = false
        await WorkflowState.writeRun(sid, "msg-1", {
          status: "running",
          workflowName: "demo",
          runId: "run-cancel",
          phases: [{ title: "Scan" }],
          agents: [],
          logs: [],
          resumable: true,
        })
        // notifyCancelled mirrors the tool layer: persist aborted and enqueue the notification
        const unregister = WorkflowState.registerRun(sid, "run-cancel", {
          abort: controller,
          async notifyCancelled() {
            const current = await WorkflowState.updateRun(sid, "run-cancel", (draft) => {
              if (draft.status === "completed" || draft.status === "failed" || draft.status === "aborted") return
              draft.status = "aborted"
              draft.completedAt = Date.now()
              draft.resumable = true
            })
            if (!current) return
            await SessionNotification.enqueue({
              id: `workflow_finished_${sid}_run-cancel`,
              sessionID: sid,
              type: "workflow.finished",
              text: "aborted",
              metadata: { runId: "run-cancel", workflowName: "demo", status: "aborted" },
            })
            notified = true
          },
        })

        try {
          const ok = await WorkflowState.cancelRun(sid, "run-cancel")
          expect(ok).toBe(true)
          expect(controller.signal.aborted).toBe(true)
          expect(notified).toBe(true)

          const run = await WorkflowState.readRun(sid, "run-cancel")
          expect(run?.status).toBe("aborted")
          expect(run?.completedAt).toBeDefined()

          // The notification is already queued without waiting for a background catch
          const pending = await SessionNotification.list(sid)
          expect(pending.some((item) => item.id === `workflow_finished_${sid}_run-cancel`)).toBe(true)
        } finally {
          unregister()
        }
      },
    })
  })

  test("cancel without notifyCancelled still aborts and stays backward compatible", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "session-cancel-legacy-" + Math.random().toString(36).slice(2)
        const controller = new AbortController()
        const unregister = WorkflowState.registerRun(sid, "run-legacy", controller)
        try {
          const ok = await WorkflowState.cancelRun(sid, "run-legacy")
          expect(ok).toBe(true)
          expect(controller.signal.aborted).toBe(true)
        } finally {
          unregister()
        }
      },
    })
  })

  // Deferred hot reload while workflows are active. drain uses setTimeout(cb, 0), so wait a tick before asserting.
  // Callbacks only count calls to check when they fire.
  const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 10))

  test("hasActive reflects the current instance's active workflow table", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "session-hasactive-" + Math.random().toString(36).slice(2)
        expect(WorkflowState.hasActive()).toBe(false)
        const unregister = WorkflowState.registerRun(sid, "r1", new AbortController())
        expect(WorkflowState.hasActive()).toBe(true)
        unregister()
        expect(WorkflowState.hasActive()).toBe(false)
      },
    })
  })

  test("requestReloadWhenIdle defers while a workflow is active and fires once after it unregisters", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "session-reload-defer-" + Math.random().toString(36).slice(2)
        const unregister = WorkflowState.registerRun(sid, "r1", new AbortController())
        let calls = 0
        WorkflowState.requestReloadWhenIdle(() => calls++)
        await nextTick()
        expect(calls).toBe(0)
        unregister()
        await nextTick()
        expect(calls).toBe(1)
      },
    })
  })

  test("requestReloadWhenIdle fires on the next tick when no workflow is active", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        let calls = 0
        WorkflowState.requestReloadWhenIdle(() => calls++)
        await nextTick()
        expect(calls).toBe(1)
      },
    })
  })

  test("requestReloadWhenIdle keeps only the latest request and fires it once when idle", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "session-reload-dedupe-" + Math.random().toString(36).slice(2)
        const unregister = WorkflowState.registerRun(sid, "r1", new AbortController())
        let a = 0
        let b = 0
        WorkflowState.requestReloadWhenIdle(() => a++)
        WorkflowState.requestReloadWhenIdle(() => b++)
        unregister()
        await nextTick()
        expect(a).toBe(0) // replaced by the later request
        expect(b).toBe(1)
      },
    })
  })

  test("cancelRun also fires the deferred reload once the active table is empty", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "session-reload-cancel-" + Math.random().toString(36).slice(2)
        WorkflowState.registerRun(sid, "r1", new AbortController())
        let calls = 0
        WorkflowState.requestReloadWhenIdle(() => calls++)
        await nextTick()
        expect(calls).toBe(0)
        await WorkflowState.cancelRun(sid, "r1")
        await nextTick()
        expect(calls).toBe(1)
      },
    })
  })
})
