/**
 * Decides when delegated work starts. Two jobs run at the same time only when they belong to different members and
 * their paths cannot touch the same file; otherwise the later one waits. Jobs start in the order they were admitted.
 */
import path from "node:path"
import { FileTime } from "../file/time"
import { Instance } from "../project/instance"
import { clear, overlap, roots } from "./paths"

type Job = { seatID: string; product: string; paths: string[] }
type Slot = Job & { done: Promise<void> }

const running = new Map<string, Slot[]>()

function conflict(a: Job, b: Job) {
  return a.seatID === b.seatID || overlap(a.paths, b.paths)
}

/**
 * Runs a member's work when the schedule allows. An external CLI writes files without FileTime, so while it runs,
 * Merak's own writes wait: under its paths when they are clear, everywhere when they are not. A Merak member writes
 * through FileTime itself and holds nothing.
 */
export async function runAdmitted<T>(sessionID: string, job: Job, fn: () => Promise<T>): Promise<T> {
  // Registered synchronously, so calls made in the same step queue in call order
  const ahead = (running.get(sessionID) ?? []).filter((slot) => conflict(slot, job))
  let finish = () => {}
  const slot: Slot = { ...job, done: new Promise<void>((resolve) => (finish = resolve)) }
  running.set(sessionID, [...(running.get(sessionID) ?? []), slot])
  try {
    await Promise.all(ahead.map((item) => item.done))
    return await hold(job, fn)
  } finally {
    finish()
    const rest = (running.get(sessionID) ?? []).filter((item) => item !== slot)
    if (rest.length) running.set(sessionID, rest)
    else running.delete(sessionID)
  }
}

async function hold<T>(job: Job, fn: () => Promise<T>) {
  if (job.product === "merak") return fn()
  if (clear(job.paths))
    return FileTime.holdDirectories(
      roots(job.paths).map((item) => path.join(Instance.directory, item)),
      fn,
    )
  const release = await FileTime.acquireBarrier()
  try {
    return await fn()
  } finally {
    release()
  }
}
