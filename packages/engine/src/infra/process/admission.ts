/**
 * Decides when delegated work starts. Two jobs run at the same time only when they belong to different members and
 * their paths cannot touch the same file; otherwise the later one waits. Jobs start in the order they were admitted.
 */
import path from "node:path"
import { realpathSync } from "node:fs"
import { FileTime } from "../file/time"
import { Instance } from "../project/instance"
import { clear, overlap, roots } from "./work-paths"

type Job = { seatID: string; product: string; paths: string[] }
type Slot = Job & { owner: string; done: Promise<void> }

const running = new Map<string, Slot[]>()

function conflict(a: Slot, b: Job & { owner: string }) {
  return a.owner === b.owner || overlap(a.paths, b.paths)
}

/**
 * Runs a member's work when the schedule allows. An external CLI writes files without FileTime, so while it runs,
 * Merak's own writes wait: under its paths when they are clear, everywhere when they are not. A Merak member writes
 * through FileTime itself and holds nothing.
 */
export async function runAdmitted<T>(
  sessionID: string,
  job: Job,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted()
  const directory = realpathSync.native(Instance.directory)
  const key = process.platform === "win32" ? directory.toLowerCase() : directory
  const owner = `${sessionID}\0${job.seatID}`
  const normalized = {
    ...job,
    owner,
    paths: job.paths.map((item) => (process.platform === "win32" ? item.toLowerCase() : item)),
  }
  // Registered synchronously, so calls made in the same step queue in call order
  const ahead = (running.get(key) ?? []).filter((slot) => conflict(slot, normalized))
  let finish = () => {}
  const slot: Slot = { ...normalized, done: new Promise<void>((resolve) => (finish = resolve)) }
  running.set(key, [...(running.get(key) ?? []), slot])
  try {
    await waiting(Promise.all(ahead.map((item) => item.done)), signal)
    signal?.throwIfAborted()
    return await hold(job, fn, signal)
  } finally {
    finish()
    const rest = (running.get(key) ?? []).filter((item) => item !== slot)
    if (rest.length) running.set(key, rest)
    else running.delete(key)
  }
}

async function hold<T>(job: Job, fn: () => Promise<T>, signal?: AbortSignal) {
  if (job.product === "merak") return fn()
  if (clear(job.paths))
    return FileTime.holdDirectories(
      roots(job.paths).map((item) => path.resolve(Instance.directory, item)),
      fn,
      signal,
    )
  const release = await FileTime.acquireBarrier(signal)
  try {
    signal?.throwIfAborted()
    return await fn()
  } finally {
    release()
  }
}

async function waiting<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  const stopped = Promise.withResolvers<never>()
  const cancel = () => stopped.reject(signal.reason)
  signal.addEventListener("abort", cancel, { once: true })
  try {
    return await Promise.race([promise, stopped.promise])
  } finally {
    signal.removeEventListener("abort", cancel)
  }
}
