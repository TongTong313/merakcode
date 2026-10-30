import { describe, expect, test } from "vitest"
import { awaitLoopStopped, cancelSessionTree, type CancelTreeDeps } from "../loop/cancel-tree"

/** Stubs that record each primitive call; no workflows, bash jobs or children unless a test overrides them */
function makeDeps(overrides: Partial<CancelTreeDeps> = {}) {
  const calls = {
    cancelSelf: [] as string[],
    cancelWorkflowRun: [] as Array<[string, string]>,
    stopBashJob: [] as string[],
  }
  const deps: CancelTreeDeps = {
    cancelSelf: (sid) => void calls.cancelSelf.push(sid),
    listWorkflowRuns: async () => [],
    cancelWorkflowRun: async (sid, runId) => void calls.cancelWorkflowRun.push([sid, runId]),
    listBashJobs: () => [],
    stopBashJob: async (id) => void calls.stopBashJob.push(id),
    listChildren: async () => [],
    ...overrides,
  }
  return { calls, deps }
}

describe("cancelSessionTree", () => {
  test("stops the root session via cancelSelf", async () => {
    const { calls, deps } = makeDeps()
    await cancelSessionTree("s1", deps)
    expect(calls.cancelSelf).toEqual(["s1"])
  })

  test("cancels running and paused workflow runs and skips finished ones", async () => {
    const { calls, deps } = makeDeps({
      listWorkflowRuns: async () => [
        { runId: "r_run", status: "running" },
        { runId: "r_paused", status: "paused" },
        { runId: "r_done", status: "completed" },
        { runId: "r_aborted", status: "aborted" },
      ],
    })
    await cancelSessionTree("s1", deps)
    expect(calls.cancelWorkflowRun).toEqual([
      ["s1", "r_run"],
      ["s1", "r_paused"],
    ])
  })

  test("stops only this session's running background bash jobs", async () => {
    const { calls, deps } = makeDeps({
      listBashJobs: () => [
        { id: "j_mine", sessionID: "s1", status: "running" },
        { id: "j_other", sessionID: "s2", status: "running" },
        { id: "j_stopped", sessionID: "s1", status: "stopped" },
      ],
    })
    await cancelSessionTree("s1", deps)
    expect(calls.stopBashJob).toEqual(["j_mine"])
  })

  test("recursively stops child sessions and their background jobs", async () => {
    const childrenOf: Record<string, Array<{ id: string }>> = { s1: [{ id: "c1" }], c1: [{ id: "c2" }] }
    const { calls, deps } = makeDeps({
      listChildren: async (sid) => childrenOf[sid] ?? [],
      listBashJobs: () => [{ id: "j_c2", sessionID: "c2", status: "running" }],
    })
    await cancelSessionTree("s1", deps)
    expect(calls.cancelSelf).toEqual(["s1", "c1", "c2"])
    expect(calls.stopBashJob).toEqual(["j_c2"])
  })

  test("a failure to stop one background task does not block the others", async () => {
    const { calls, deps } = makeDeps({
      listWorkflowRuns: async () => [{ runId: "r1", status: "running" }],
      cancelWorkflowRun: async () => {
        throw new Error("cancel failed")
      },
      listBashJobs: () => [{ id: "j1", sessionID: "s1", status: "running" }],
    })
    await cancelSessionTree("s1", deps)
    expect(calls.stopBashJob).toEqual(["j1"])
  })

  // Undo must not continue (and touch files) before the loop has stopped, or it races a loop still writing files.
  test("waits for the loop-stopped promise from cancelSelf before recursing into children", async () => {
    const order: string[] = []
    let releaseStopped!: () => void
    const stopped = new Promise<void>((resolve) => {
      releaseStopped = () => {
        order.push("stopped")
        resolve()
      }
    })
    const { deps } = makeDeps({
      cancelSelf: (sid) => {
        order.push("cancelSelf:" + sid)
        return stopped
      },
      listChildren: async (sid) => {
        order.push("listChildren:" + sid)
        return []
      },
    })
    const p = cancelSessionTree("s1", deps)
    // Drain microtasks: nothing may recurse into children before stopped resolves.
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(["cancelSelf:s1"])
    releaseStopped()
    await p
    expect(order).toEqual(["cancelSelf:s1", "stopped", "listChildren:s1"])
  })

  test("does not wait when cancelSelf returns undefined and still recurses into children", async () => {
    const { calls, deps } = makeDeps({
      listChildren: async (sid) => (sid === "s1" ? [{ id: "c1" }] : []),
    })
    await cancelSessionTree("s1", deps)
    expect(calls.cancelSelf).toEqual(["s1", "c1"])
  })
})

// sleep is injected so the timeout is deterministic instead of racing real timers.
describe("awaitLoopStopped", () => {
  test("returns immediately when done is undefined", async () => {
    let returned = false
    await awaitLoopStopped(undefined)
    returned = true
    expect(returned).toBe(true)
  })

  test("returns after the timeout when the loop never stops", async () => {
    const stuck = new Promise<void>(() => {})
    let returned = false
    await awaitLoopStopped(stuck, 3000, () => Promise.resolve()) // timeout fires immediately
    returned = true
    expect(returned).toBe(true)
  })

  test("returns as soon as done resolves without waiting for the timeout", async () => {
    const neverSleep = () => new Promise<void>(() => {})
    let returned = false
    await awaitLoopStopped(Promise.resolve(), 3000, neverSleep)
    returned = true
    expect(returned).toBe(true)
  })
})
