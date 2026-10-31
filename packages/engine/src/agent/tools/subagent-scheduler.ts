import { Instance } from "../../infra/project/instance"

// Subagents running at once per parent session; further calls wait in a FIFO queue. Readers and writers are not
// distinguished: file-level safety comes from FileTime (withLock plus mtime optimistic locking).
export const MAX_CONCURRENT_SUBAGENTS = 5

// FIFO semaphore that keeps at most `capacity` holders at once. When the parent session aborts, a pending acquire
// rejects with AbortError and leaves the queue.
class Semaphore {
  private inflight = 0
  private waiters: Array<() => void> = []

  constructor(private readonly capacity: number) {}

  // Resolves with a function that releases the permit
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError")
    if (this.inflight < this.capacity) {
      this.inflight++
      return () => this.release()
    }
    return new Promise<() => void>((resolve, reject) => {
      const grant = () => {
        if (signal.aborted) return
        this.inflight++
        cleanup()
        resolve(() => this.release())
      }
      const onAbort = () => {
        const i = this.waiters.indexOf(grant)
        if (i >= 0) this.waiters.splice(i, 1)
        cleanup()
        reject(new DOMException("aborted", "AbortError"))
      }
      const cleanup = () => signal.removeEventListener("abort", onAbort)
      this.waiters.push(grant)
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  private release() {
    this.inflight--
    const next = this.waiters.shift()
    if (next) next()
  }
}

// One semaphore per Instance (project directory) and parent session, so parallel sessions in the same project do
// not hold each other up
const state = Instance.state(() => new Map<string, Semaphore>())

export function semaphoreFor(parentSessionID: string): Semaphore {
  const m = state()
  let s = m.get(parentSessionID)
  if (!s) {
    s = new Semaphore(MAX_CONCURRENT_SUBAGENTS)
    m.set(parentSessionID, s)
  }
  return s
}
