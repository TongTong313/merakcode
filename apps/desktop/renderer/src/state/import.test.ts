import type { EngineEvent, ProtocolImportStatus } from "@merakcode/sdk"
import { expect, test } from "vitest"
import { progressOf, statusProgress } from "./import"

const progress = (done: number, total: number, from = "v0.3") =>
  ({
    id: "evt",
    stream: "import",
    time: "2025-01-01T00:00:00Z",
    type: "import.progress",
    scope: {},
    actor: { kind: "system" },
    payload: { from, done, total },
  }) as unknown as EngineEvent

test("an import.progress event says how far the import is, and it is running until every conversation is done", () => {
  expect(progressOf(progress(0, 3))).toEqual({ running: true, done: 0, total: 3 })
  expect(progressOf(progress(2, 3))).toEqual({ running: true, done: 2, total: 3 })
  expect(progressOf(progress(3, 3))).toEqual({ running: false, done: 3, total: 3 })
})

test("other events, and an import with nothing in it, say nothing about progress", () => {
  expect(progressOf({ ...progress(0, 3), type: "session.updated" } as unknown as EngineEvent)).toBeUndefined()
  expect(progressOf(progress(0, 0))).toEqual({ running: false, done: 0, total: 0 })
})

test("the status of the engine gives the same picture: running only while its state says so", () => {
  const status = (state: string, done: number, total: number) =>
    ({ found: true, state, done, total }) as ProtocolImportStatus
  expect(statusProgress(status("running", 1, 4))).toEqual({ running: true, done: 1, total: 4 })
  expect(statusProgress(status("done", 4, 4))).toEqual({ running: false, done: 4, total: 4 })
  expect(statusProgress(status("idle", 0, 0))).toEqual({ running: false, done: 0, total: 0 })
})
