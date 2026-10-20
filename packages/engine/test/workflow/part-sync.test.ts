/**
 * WorkflowPartSync copies the terminal state of a persisted workflow record into the completed workflow_run tool part
 * (part.state.metadata). Without it the record says aborted while the chat card stays stuck on the running snapshot
 * taken at launch.
 *
 * workflow_run is fire-and-forget: the part completes as soon as execute returns, and its metadata is only updated
 * through the in-process ctx.metadata, which needs a live processor. Aborts outside the process (reconcile on resume,
 * dispose on shutdown, records that were already terminal) have no live processor, so the part stays running. This
 * module updates the part from record.messageID + runId whether or not a processor is alive.
 *
 * Parts are seeded with Session.updatePart, the same public API the processor uses to write a tool result, so their
 * shape matches the real pipeline. End-to-end coverage with a real processor lives in
 * session/processor-workflow-terminal.test.ts.
 */
import { expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { Message } from "@merakcode/engine/session/message"
import { Identifier } from "@merakcode/util/id"
import { WorkflowState } from "@merakcode/engine/workflow/state"
import { WorkflowPartSync } from "@merakcode/engine/workflow/part-sync"
import type { WorkflowRunControl, WorkflowRunMetadata, WorkflowRunRecord } from "@merakcode/engine/workflow/types"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function runningMetadata(runId: string, overrides: Partial<WorkflowRunMetadata> = {}): WorkflowRunMetadata {
  return {
    status: "running",
    workflowName: "demo",
    runId,
    phases: [{ title: "Generate" }, { title: "Verify" }],
    agents: [],
    logs: [],
    resumable: true,
    ...overrides,
  }
}

/** Seeds a completed workflow_run tool part whose workflow metadata is stuck in the given state (running by default). */
async function seedWorkflowPart(input: {
  sessionID: string
  messageID: string
  callID: string
  metadata: WorkflowRunMetadata
}) {
  const now = Date.now()
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: input.messageID,
    sessionID: input.sessionID,
    type: "tool",
    tool: "workflow_run",
    callID: input.callID,
    state: {
      status: "completed",
      input: {},
      output: "Workflow launched in background.",
      title: input.metadata.workflowName,
      metadata: input.metadata,
      time: { start: now, end: now },
    },
  })
}

function findWorkflowPart(parts: Message.Part[], runId?: string) {
  return parts.find(
    (p): p is Message.ToolPart =>
      p.type === "tool" &&
      p.tool === "workflow_run" &&
      (runId === undefined || (p.state as { metadata?: { runId?: string } }).metadata?.runId === runId),
  )
}

function partMeta(part: Message.ToolPart | undefined) {
  return (part?.state as { metadata?: Record<string, unknown> } | undefined)?.metadata
}

// Storage is a process-wide singleton and listRuns scans the global directory, so each test uses a unique sessionID.
function uniqueSession(tag: string) {
  return `session-partsync-${tag}-` + Math.random().toString(36).slice(2)
}

test("backstop scan: syncRuns updates a part stuck on running to aborted when its record is already terminal", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sid = uniqueSession("a2")
      const messageID = Identifier.ascending("message")

      // Part is completed but its workflow metadata is stuck on running from launch
      await seedWorkflowPart({ sessionID: sid, messageID, callID: "tc-a2", metadata: runningMetadata("r1") })

      // Record is already aborted; reconcile skips terminal records and emits no event, so a subscriber alone
      // cannot fix the part
      await WorkflowState.writeRun(
        sid,
        messageID,
        runningMetadata("r1", { status: "aborted", completedAt: Date.now() }),
      )

      // The workflow.list route runs this scan after listRuns
      await WorkflowPartSync.syncRuns(await WorkflowState.listRuns(sid))

      const part = findWorkflowPart(await Message.parts({ sessionID: sid, messageID }))
      expect(part?.state.status).toBe("completed") // the part lifecycle status is unchanged
      const meta = partMeta(part)
      expect(meta?.status).toBe("aborted")
      expect(meta?.runId).toBe("r1")
      expect(Array.isArray(meta?.agents)).toBe(true) // required by the client's workflowRunMetadata guard
    },
  })
})

test("subscriber updates the part as soon as resume reconcile marks a zombie running record aborted", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sid = uniqueSession("a")
      const messageID = Identifier.ascending("message")
      await seedWorkflowPart({ sessionID: sid, messageID, callID: "tc-a", metadata: runningMetadata("r1") })
      await WorkflowState.writeRun(sid, messageID, runningMetadata("r1")) // running but never registered

      WorkflowPartSync.init() // registers the per-instance subscriber

      // On resume, listRuns reconciles the zombie run to aborted and emits Event.Updated, which the subscriber
      // applies to the part
      const runs = await WorkflowState.listRuns(sid)
      expect(runs.find((r) => r.runId === "r1")?.status).toBe("aborted")

      const after = findWorkflowPart(await Message.parts({ sessionID: sid, messageID }))
      expect(after?.state.status).toBe("completed")
      expect(partMeta(after)?.status).toBe("aborted")
    },
  })
})

test("user cancel: notifyCancelled persists aborted and the subscriber updates the part", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sid = uniqueSession("b")
      const messageID = Identifier.ascending("message")
      await seedWorkflowPart({ sessionID: sid, messageID, callID: "tc-b", metadata: runningMetadata("r1") })
      await WorkflowState.writeRun(sid, messageID, runningMetadata("r1"))

      WorkflowPartSync.init()

      // Mirrors tool/workflow.ts: notifyCancelled persists the record as aborted
      const control: WorkflowRunControl = {
        abort: new AbortController(),
        async notifyCancelled() {
          await WorkflowState.updateRun(sid, "r1", (draft) => {
            if (draft.status === "completed" || draft.status === "failed" || draft.status === "aborted") return
            draft.status = "aborted"
            draft.completedAt = Date.now()
            draft.resumable = true
          })
        },
      }
      WorkflowState.registerRun(sid, "r1", control)

      expect(await WorkflowState.cancelRun(sid, "r1")).toBe(true)
      expect((await WorkflowState.readRun(sid, "r1"))?.status).toBe("aborted")

      const after = findWorkflowPart(await Message.parts({ sessionID: sid, messageID }))
      expect(partMeta(after)?.status).toBe("aborted")
    },
  })
})

test("Event.Updated for a running record leaves the part alone", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sid = uniqueSession("c1")
      const messageID = Identifier.ascending("message")
      // runningAgentCount=5 stands in for live progress written through the in-process ctx.metadata
      await seedWorkflowPart({
        sessionID: sid,
        messageID,
        callID: "tc-c1",
        metadata: runningMetadata("r1", { runningAgentCount: 5 }),
      })

      WorkflowPartSync.init()
      // Progress write: emits Event.Updated for a non-terminal record with a different runningAgentCount
      await WorkflowState.writeRun(sid, messageID, runningMetadata("r1", { runningAgentCount: 2 }))

      const after = findWorkflowPart(await Message.parts({ sessionID: sid, messageID }))
      expect(partMeta(after)?.status).toBe("running")
      // The part was not written for a non-terminal event, otherwise runningAgentCount would be 2
      expect(partMeta(after)?.runningAgentCount).toBe(5)
    },
  })
})

test("a part already in a richer terminal state is not overwritten by aborted", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sid = uniqueSession("c2")
      const messageID = Identifier.ascending("message")
      // The in-process ctx.metadata already wrote a completed state with result and agents
      await seedWorkflowPart({
        sessionID: sid,
        messageID,
        callID: "tc-c2",
        metadata: runningMetadata("r1", {
          status: "completed",
          agents: [{ id: "a1", label: "bubble", agent: "workflow-subagent", status: "completed" }],
          result: { ok: true },
        }),
      })

      WorkflowPartSync.init()
      // The record is marked aborted late (e.g. by the dispose fallback); the completed part must stay intact
      await WorkflowState.writeRun(
        sid,
        messageID,
        runningMetadata("r1", { status: "aborted", completedAt: Date.now() }),
      )

      const after = findWorkflowPart(await Message.parts({ sessionID: sid, messageID }))
      expect(partMeta(after)?.status).toBe("completed")
      expect((partMeta(after)?.result as { ok?: boolean } | undefined)?.ok).toBe(true)
      expect((partMeta(after)?.agents as unknown[] | undefined)?.length).toBe(1)
    },
  })
})

test("with several parts, only the part matching the aborted record's runId is updated", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sid = uniqueSession("e")
      const messageID = Identifier.ascending("message")
      await seedWorkflowPart({ sessionID: sid, messageID, callID: "tc-e1", metadata: runningMetadata("r1") })
      await seedWorkflowPart({ sessionID: sid, messageID, callID: "tc-e2", metadata: runningMetadata("r2") })

      const abortedR1: WorkflowRunRecord = {
        ...runningMetadata("r1", { status: "aborted", completedAt: Date.now() }),
        sessionID: sid,
        messageID,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await WorkflowPartSync.syncRuns([abortedR1])

      const parts = await Message.parts({ sessionID: sid, messageID })
      expect(partMeta(findWorkflowPart(parts, "r1"))?.status).toBe("aborted")
      expect(partMeta(findWorkflowPart(parts, "r2"))?.status).toBe("running")
    },
  })
})

test("missing or invalid messageID returns silently without throwing or touching storage", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sid = uniqueSession("f")
      const validMessageID = Identifier.ascending("message")
      // A valid part proves the invalid syncs do not modify existing messages
      await seedWorkflowPart({
        sessionID: sid,
        messageID: validMessageID,
        callID: "tc-f",
        metadata: runningMetadata("r-keep"),
      })
      const before = partMeta(
        findWorkflowPart(await Message.parts({ sessionID: sid, messageID: validMessageID }), "r-keep"),
      )

      const base = runningMetadata("r1", { status: "aborted", completedAt: Date.now() })
      const noMessageID: WorkflowRunRecord = {
        ...base,
        sessionID: sid,
        messageID: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      // Message.parts throws on an invalid messageID; the error must be swallowed
      const badMessageID: WorkflowRunRecord = {
        ...base,
        sessionID: sid,
        messageID: "not-a-valid-message-id",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      // Unguarded, these calls would reject and, in the real chain, make writeRun reject too
      await expect(WorkflowPartSync.syncRunToPart(noMessageID)).resolves.toBeUndefined()
      await expect(WorkflowPartSync.syncRunToPart(badMessageID)).resolves.toBeUndefined()
      await expect(WorkflowPartSync.syncRunToPart(undefined)).resolves.toBeUndefined()

      const after = partMeta(
        findWorkflowPart(await Message.parts({ sessionID: sid, messageID: validMessageID }), "r-keep"),
      )
      expect(after).toEqual(before)
      expect(after?.status).toBe("running")
    },
  })
})
