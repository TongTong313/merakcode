import { describe, expect, test } from "vitest"
import z from "zod"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { BusEvent } from "@merakcode/engine/infra/bus/bus-event"
import { GlobalBus } from "@merakcode/engine/infra/bus/global"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { EventStream } from "@merakcode/engine/app/server/event-stream"
import { Server } from "@merakcode/engine/app/server/server"
import { tmpdir } from "../fixture/fixture"
import { setTimeout as delay } from "node:timers/promises"

interface Payload {
  type: string
  properties?: { sequence: number }
}

function fake(block?: Promise<void>) {
  const writes: unknown[] = []
  const aborts: Array<() => void | Promise<void>> = []
  const stream = {
    aborted: false,
    closed: false,
    async writeSSE(message: { data: string | Promise<string> }) {
      writes.push(JSON.parse(await message.data))
      if (writes.length === 1) await block
    },
    async close() {
      stream.closed = true
    },
    onAbort(listener: () => void | Promise<void>) {
      aborts.push(listener)
    },
  }
  return {
    stream,
    writes,
    async abort() {
      stream.aborted = true
      await Promise.all(aborts.map((abort) => abort()))
    },
  }
}

async function waitFor(check: () => boolean, attempts = 100): Promise<void> {
  if (check()) return
  if (!attempts) throw new Error("timed out waiting for event stream")
  await delay(1)
  return waitFor(check, attempts - 1)
}

function reader(response: Response) {
  const body = response.body
  if (!body) throw new Error("missing event stream body")
  const input = body.getReader()
  const decoder = new TextDecoder()
  const state = { buffer: "" }
  return {
    async next(): Promise<unknown> {
      const boundary = state.buffer.indexOf("\n\n")
      if (boundary !== -1) {
        const frame = state.buffer.slice(0, boundary)
        state.buffer = state.buffer.slice(boundary + 2)
        return JSON.parse(
          frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n"),
        )
      }

      const chunk = await input.read()
      if (chunk.done) throw new Error("event stream ended before the next event")
      state.buffer += decoder.decode(chunk.value, { stream: true })
      return this.next()
    },
    close: () => input.cancel(),
  }
}

describe("EventStream", () => {
  test("queues events published while connected is still being written", async () => {
    const gate = Promise.withResolvers<void>()
    const output = fake(gate.promise)
    const state = { listener: (_event: Payload) => {}, unsubs: 0 }
    const running = EventStream.run({
      stream: output.stream,
      subscribe(listener) {
        state.listener = listener
        return () => state.unsubs++
      },
      connected: { type: "server.connected" },
      heartbeat: { type: "server.heartbeat" },
      interval: 60_000,
    })

    await waitFor(() => output.writes.length === 1)
    state.listener({ type: "one" })
    state.listener({ type: "two" })
    state.listener({ type: "three" })
    expect(output.writes).toEqual([{ type: "server.connected" }])

    gate.resolve()
    await waitFor(() => output.writes.length === 4)
    await output.abort()
    await running

    expect(output.writes).toEqual([{ type: "server.connected" }, { type: "one" }, { type: "two" }, { type: "three" }])
    expect(state.unsubs).toBe(1)
  })

  test("keeps one FIFO per connection when another writer is blocked", async () => {
    const listeners = new Set<(event: Payload) => void>()
    const subscribe = (listener: (event: Payload) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    const gate = Promise.withResolvers<void>()
    const first = fake(gate.promise)
    const second = fake()
    const one = EventStream.run({
      stream: first.stream,
      subscribe,
      connected: { type: "server.connected" },
      heartbeat: { type: "server.heartbeat" },
      interval: 60_000,
    })
    const two = EventStream.run({
      stream: second.stream,
      subscribe,
      connected: { type: "server.connected" },
      heartbeat: { type: "server.heartbeat" },
      interval: 60_000,
    })

    await waitFor(() => first.writes.length === 1 && second.writes.length === 1)
    Array.from({ length: 3 }, (_, index) => index + 1).forEach((sequence) =>
      listeners.forEach((listener) => listener({ type: "item", properties: { sequence } })),
    )
    await waitFor(() => second.writes.length === 4)

    const expected = [
      { type: "server.connected" },
      { type: "item", properties: { sequence: 1 } },
      { type: "item", properties: { sequence: 2 } },
      { type: "item", properties: { sequence: 3 } },
    ]
    expect(second.writes).toEqual(expected)
    expect(first.writes).toEqual([{ type: "server.connected" }])

    gate.resolve()
    await waitFor(() => first.writes.length === 4)

    await Promise.all([first.abort(), second.abort()])
    await Promise.all([one, two])
    expect(first.writes).toEqual(expected)
    expect(listeners.size).toBe(0)
  })

  test("delivers a closing event before releasing the connection", async () => {
    const output = fake()
    const state = { listener: (_event: Payload) => {}, unsubs: 0 }
    const running = EventStream.run({
      stream: output.stream,
      subscribe(listener) {
        state.listener = listener
        return () => state.unsubs++
      },
      connected: { type: "server.connected" },
      heartbeat: { type: "server.heartbeat" },
      close: (event) => event.type === "server.instance.disposed",
      interval: 60_000,
    })

    await waitFor(() => output.writes.length === 1)
    state.listener({ type: "server.instance.disposed" })
    await running

    expect(output.writes).toEqual([{ type: "server.connected" }, { type: "server.instance.disposed" }])
    expect(output.stream.closed).toBe(true)
    expect(state.unsubs).toBe(1)
  })

  test("stops heartbeats and releases the listener after abort", async () => {
    const output = fake()
    const state = { unsubs: 0 }
    const running = EventStream.run({
      stream: output.stream,
      subscribe: () => () => state.unsubs++,
      connected: { type: "server.connected" },
      heartbeat: { type: "server.heartbeat" },
      interval: 2,
    })

    await waitFor(() => output.writes.length >= 2)
    await output.abort()
    await running
    const count = output.writes.length
    await delay(10)

    expect(output.writes).toHaveLength(count)
    expect(state.unsubs).toBe(1)
  })
})

describe("Server event routes", () => {
  test("instance and global connections preserve their envelopes and FIFO order", async () => {
    await using tmp = await tmpdir()
    const app = Server.App()
    const Event = BusEvent.define("test.event-stream", z.object({ sequence: z.number() }))
    const instanceResponses = await Promise.all(
      [1, 2].map(() => app.request(`http://localhost/event?directory=${encodeURIComponent(tmp.path)}`)),
    )
    const globalResponse = await app.request("http://localhost/global/event")
    const instances = instanceResponses.map(reader)
    const global = reader(globalResponse)

    expect(await Promise.all(instances.map((stream) => stream.next()))).toEqual([
      { type: "server.connected", properties: {} },
      { type: "server.connected", properties: {} },
    ])
    expect(await global.next()).toEqual({ payload: { type: "server.connected", properties: {} } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Bus.publish(Event, { sequence: 1 })
        await Bus.publish(Event, { sequence: 2 })
        await Bus.publish(Event, { sequence: 3 })
      },
    })

    const expected = [1, 2, 3].map((sequence) => ({ type: Event.type, properties: { sequence } }))
    await Promise.all(
      instances.map(async (stream) => expect(await Promise.all(expected.map(() => stream.next()))).toEqual(expected)),
    )
    expect(await Promise.all(expected.map(() => global.next()))).toEqual(
      expected.map((payload) => ({ directory: tmp.path, payload })),
    )

    const baseline = GlobalBus.listenerCount("event") - 1
    await Promise.all([...instances.map((stream) => stream.close()), global.close()])
    await waitFor(() => GlobalBus.listenerCount("event") === baseline)
  })
})
