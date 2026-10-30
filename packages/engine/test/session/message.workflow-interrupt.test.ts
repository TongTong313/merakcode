import { describe, expect, test } from "vitest"
import { Message } from "@merakcode/engine/agent/session/message"

/**
 * workflow_run is fire-and-forget: once detached to the background, its tool part stays at state.status="running"
 * because the turn ends abnormally and the processor skips it, while ctx.metadata in the runner keeps writing the
 * background progress (possibly terminal) onto that part. So "status=running but metadata.status is terminal" is a
 * permanent steady state.
 *
 * Serializing every pending/running part as "[Tool execution was interrupted]" made the main agent read "interrupted"
 * every turn, give up waiting and do the work itself. resolveInterruptedToolResult has three outcomes and only reports
 * interrupted when nothing is running in the background.
 */

// Minimal workflow_run tool part; the cast skips the remaining fields.
const workflowPart = (state: unknown) =>
  ({ type: "tool", callID: "c1", tool: "workflow_run", state }) as unknown as Message.ToolPart

const runningState = (metadata?: unknown) => ({
  status: "running",
  input: {},
  time: { start: 0 },
  ...(metadata !== undefined ? { metadata } : {}),
})

const OLD_INTERRUPTED = "[Tool execution was interrupted]"

describe("message.resolveInterruptedToolResult", () => {
  test("running workflow_run with running metadata is workflow-running, not interrupted or completed", () => {
    const r = Message.__test.resolveInterruptedToolResult(
      workflowPart(runningState({ status: "running", workflowName: "demo", runId: "r1" })),
    )
    expect(r.kind).toBe("workflow-running")
    if (r.kind !== "workflow-running") throw new Error("expected workflow-running")
    // The model must be told it is still running in the background.
    expect(r.output).toContain("RUNNING")
    expect(r.output).toContain("background")
    // Never the old misleading text, "interrupted", or completion wording.
    expect(r.output).not.toContain(OLD_INTERRUPTED)
    expect(r.output.toLowerCase()).not.toContain("interrupted")
    expect(r.output.toLowerCase()).not.toContain("completed")
  })

  test("running workflow_run with terminal metadata is workflow-terminal, not interrupted", () => {
    for (const status of ["completed", "failed", "aborted"]) {
      const r = Message.__test.resolveInterruptedToolResult(
        workflowPart(runningState({ status, workflowName: "demo", runId: "r1" })),
      )
      expect(r.kind).toBe("workflow-terminal")
      if (r.kind !== "workflow-terminal") throw new Error("expected workflow-terminal")
      expect(r.output).toContain(`terminal status "${status}"`)
      expect(r.output).not.toContain(OLD_INTERRUPTED)
      expect(r.output.toLowerCase()).not.toContain("interrupted")
    }
  })

  test("running workflow_run without metadata is interrupted, since the background run never started", () => {
    expect(Message.__test.resolveInterruptedToolResult(workflowPart(runningState()))).toStrictEqual({
      kind: "interrupted",
      errorText: OLD_INTERRUPTED,
    })
  })

  test("running workflow_run with metadata but no status is interrupted", () => {
    expect(
      Message.__test.resolveInterruptedToolResult(workflowPart(runningState({ workflowName: "demo" }))),
    ).toStrictEqual({ kind: "interrupted", errorText: OLD_INTERRUPTED })
  })

  test("pending workflow_run is interrupted, since pending has no metadata", () => {
    const part = {
      type: "tool",
      callID: "c1",
      tool: "workflow_run",
      state: { status: "pending", input: {}, raw: "" },
    } as unknown as Message.ToolPart
    expect(Message.__test.resolveInterruptedToolResult(part)).toStrictEqual({
      kind: "interrupted",
      errorText: OLD_INTERRUPTED,
    })
  })

  test("running non-workflow tool (bash) is still interrupted", () => {
    const part = {
      type: "tool",
      callID: "c1",
      tool: "bash",
      state: runningState({ status: "running" }),
    } as unknown as Message.ToolPart
    expect(Message.__test.resolveInterruptedToolResult(part)).toStrictEqual({
      kind: "interrupted",
      errorText: OLD_INTERRUPTED,
    })
  })

  test("paused workflow_run (running metadata with isPaused) is workflow-running", () => {
    const r = Message.__test.resolveInterruptedToolResult(
      workflowPart(runningState({ status: "running", isPaused: true, workflowName: "demo", runId: "r1" })),
    )
    expect(r.kind).toBe("workflow-running")
  })
})
