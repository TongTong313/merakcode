import { expect, test } from "vitest"
import type { GlobalEvent } from "@merakcode/sdk/client"
import { createSDKEvents, type Subscription } from "../../src/cli/cmd/tui/context/sdk-events"

const connected: GlobalEvent = { directory: "", payload: { type: "server.connected", properties: {} } }
const business: GlobalEvent = {
  directory: "project",
  payload: { type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } },
}

test("RPC becomes ready only after listener installation and releases a late subscription on close", async () => {
  const installed = Promise.withResolvers<() => void>()
  let handler: ((value: GlobalEvent) => void) | undefined
  let disposed = 0
  const states: Subscription[] = []
  const emitted: GlobalEvent[] = []
  const events = createSDKEvents({
    signal: new AbortController().signal,
    source: {
      subscribe: async (callback) => {
        handler = callback
        return installed.promise
      },
    },
    stream: async () => {
      throw new Error("RPC must not open SSE")
    },
    changed: (state) => states.push(state),
    emit: (batch) => emitted.push(...batch),
    failed: () => {
      throw new Error("unexpected failure")
    },
  })
  const starting = events.start()
  expect(states).toEqual([{ generation: 1, ready: false }])
  events.close()
  installed.resolve(() => disposed++)
  await starting
  handler!(business)
  expect(disposed).toBe(1)
  expect(states.every((state) => !state.ready)).toBe(true)
  expect(emitted).toEqual([])
})

test("RPC announces readiness after subscribe resolves without requiring server.connected", async () => {
  const installed = Promise.withResolvers<() => void>()
  const states: Subscription[] = []
  let disposed = 0
  const events = createSDKEvents({
    signal: new AbortController().signal,
    source: { subscribe: () => installed.promise },
    stream: async () => {
      throw new Error("RPC must not open SSE")
    },
    changed: (state) => states.push(state),
    emit: () => {},
    failed: () => {},
  })
  const starting = events.start()
  expect(states.at(-1)?.ready).toBe(false)
  installed.resolve(() => disposed++)
  await starting
  expect(states.at(-1)).toEqual({ generation: 1, ready: true })
  events.close()
  expect(disposed).toBe(1)
})

test("SSE raw connected starts each generation and queued shared events survive stream completion", async () => {
  const finish = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const opened = Promise.withResolvers<void>()
  const states: Subscription[] = []
  const emitted: GlobalEvent[] = []
  let streams = 0
  const events = createSDKEvents({
    signal: new AbortController().signal,
    stream: async () => ({
      stream: (async function* () {
        streams++
        if (streams === 1) {
          yield connected
          yield business
          await finish.promise
          return
        }
        yield connected
        opened.resolve()
        await second.promise
      })(),
    }),
    changed: (state) => states.push(state),
    emit: (batch) => emitted.push(...batch),
    failed: () => {},
  })
  const running = events.start()
  finish.resolve()
  await opened.promise
  expect(emitted.filter((value) => value.payload.type === "session.status")).toEqual([business])
  expect(states.filter((state) => state.ready).map((state) => state.generation)).toEqual([2, 4])
  events.close()
  second.resolve()
  await running
})

test("SSE failure delivers received events before invalidation and rejects events until the next connected", async () => {
  const completed = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const timeline: string[] = []
  const events = createSDKEvents({
    signal: new AbortController().signal,
    stream: async (failed) => ({
      stream: (async function* () {
        yield connected
        yield business
        failed(new Error("finite stream loss"))
        yield business
        yield connected
        completed.resolve()
        await gate.promise
      })(),
    }),
    changed: (state) => timeline.push(`state:${state.generation}:${state.ready}`),
    emit: (batch) => batch.forEach((value) => timeline.push(value.payload.type)),
    failed: () => timeline.push("failed"),
  })
  const running = events.start()
  await completed.promise
  expect(timeline.filter((value) => value === "session.status")).toHaveLength(1)
  expect(timeline.indexOf("session.status")).toBeLessThan(timeline.indexOf("state:3:false"))
  expect(timeline).toContain("state:4:true")
  events.close()
  gate.resolve()
  await running
})
