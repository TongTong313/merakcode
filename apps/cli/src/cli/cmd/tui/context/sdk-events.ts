import type { GlobalEvent } from "@merakcode/sdk/client"

export type EventSource = {
  subscribe(handler: (event: GlobalEvent) => void): Promise<() => void>
}

export type Subscription = { generation: number; ready: boolean }

/** The readiness boundary belongs to the raw connection, before directory filtering. */
export function createSDKEvents(input: {
  signal: AbortSignal
  source?: EventSource
  stream(onError: (error: unknown) => void): Promise<{ stream: AsyncIterable<GlobalEvent> }>
  changed(value: Subscription): void
  emit(events: GlobalEvent[]): void
  failed(error: unknown): void
}) {
  let generation = 0
  let closed = false
  let unsubscribe: (() => void) | undefined
  let queue: GlobalEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0
  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    queue = []
  }
  const advance = (ready: boolean) => {
    // Already received shared events must be delivered before changing connections.
    flush()
    clear()
    generation++
    input.changed({ generation, ready })
    return generation
  }
  const flush = () => {
    timer = undefined
    if (closed || input.signal.aborted || queue.length === 0) return
    const events = queue
    queue = []
    last = Date.now()
    input.emit(events)
  }
  const receive = (value: GlobalEvent, current: number) => {
    if (closed || input.signal.aborted || current !== generation) return
    queue.push(value)
    if (timer) return
    if (Date.now() - last < 16) timer = setTimeout(flush, 16)
    else flush()
  }
  const failed = (error: unknown) => {
    if (closed || input.signal.aborted) return
    advance(false)
    input.failed(error)
  }
  return {
    async start() {
      if (closed || input.signal.aborted) return
      const current = advance(false)
      try {
        if (input.source) {
          const dispose = await input.source.subscribe((value) => receive(value, current))
          if (closed || input.signal.aborted || generation !== current) {
            dispose()
            return
          }
          unsubscribe = dispose
          input.changed({ generation, ready: true })
          return
        }
        let accepting = false
        while (!closed && !input.signal.aborted) {
          const events = await input.stream((error) => {
            accepting = false
            failed(error)
          })
          for await (const value of events.stream) {
            if (closed || input.signal.aborted) break
            if (value.payload.type === "server.connected") {
              advance(true)
              accepting = true
            }
            if (accepting) receive(value, generation)
          }
          accepting = false
          if (!closed && !input.signal.aborted) advance(false)
        }
      } catch (error) {
        failed(error)
      }
    },
    close() {
      if (closed) return
      closed = true
      clear()
      unsubscribe?.()
      unsubscribe = undefined
      input.changed({ generation: ++generation, ready: false })
    },
  }
}
