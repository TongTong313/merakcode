import type { SSEStreamingApi } from "hono/streaming"
import { AsyncQueue } from "../util/queue"

interface Input<T> {
  stream: Pick<SSEStreamingApi, "aborted" | "closed" | "writeSSE" | "close" | "onAbort">
  subscribe: (listener: (event: T) => void) => () => void
  connected: T
  heartbeat: T
  close?: (event: T) => boolean
  interval?: number
  onClose?: () => void
}

const done = Symbol("event-stream-done")

export namespace EventStream {
  export async function run<T>(input: Input<T>) {
    const state = { active: true }
    const queue = new AsyncQueue<T | typeof done>()
    const unsub = input.subscribe((event) => {
      if (state.active) queue.push(event)
    })

    queue.push(input.connected)
    const heartbeat = setInterval(() => {
      if (state.active) queue.push(input.heartbeat)
    }, input.interval ?? 30_000)
    const cleanup = () => {
      if (!state.active) return
      state.active = false
      clearInterval(heartbeat)
      unsub()
      queue.push(done)
      input.onClose?.()
    }

    input.stream.onAbort(cleanup)

    await (async () => {
      while (state.active) {
        const event = await queue.next()
        if (!state.active || event === done) return

        await input.stream.writeSSE({ data: JSON.stringify(event) })
        if (input.stream.aborted || input.stream.closed) return
        if (!input.close?.(event)) continue

        await input.stream.close()
        return
      }
    })().finally(cleanup)
  }
}
