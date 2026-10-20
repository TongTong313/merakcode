/** Bounded, best-effort transport. No retry storms, no network on the product's critical path. */
export class LogQueue<T> {
  private pending: T[] = []
  private sending = false
  private active?: AbortController
  private transport?: (record: T, signal: AbortSignal) => Promise<unknown>
  dropped = 0

  configure(transport: (record: T, signal: AbortSignal) => Promise<unknown>) {
    if (this.transport && this.transport !== transport) this.clear()
    this.transport = transport
    void this.drain()
    return () => {
      if (this.transport === transport) {
        this.transport = undefined
        this.clear()
      }
    }
  }

  private clear() {
    this.dropped += this.pending.length
    this.pending = []
    this.active?.abort()
  }

  write(record: T) {
    if (this.pending.length >= 100) {
      this.pending.shift()
      this.dropped++
    }
    this.pending.push(record)
    void this.drain()
  }

  private async drain() {
    if (this.sending || !this.transport) return
    this.sending = true
    try {
      while (this.pending.length && this.transport) {
        const record = this.pending.shift()!
        const abort = new AbortController()
        this.active = abort
        const transport = this.transport
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            Promise.resolve().then(() => transport(record, abort.signal)),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                abort.abort()
                reject(new Error("log timeout"))
              }, 3000)
            }),
          ])
        } catch {
          this.dropped++
        } finally {
          clearTimeout(timer)
          this.active = undefined
        }
      }
    } finally {
      this.sending = false
    }
  }
}
