import fs from "fs/promises"
import path from "path"
import { statSync } from "fs"
import { Instance } from "../project/instance"
import { Log } from "@merakcode/log/logger"
import { Flag } from "../flag/flag"

export namespace FileTime {
  const log = Log.create({ service: "file.time" })
  // Per-session read times plus per-file write locks.
  // All tools that overwrite existing files should run their
  // assert/read/write/update sequence inside withLock(filepath, ...)
  // so concurrent writes to the same file are serialized.
  export const state = Instance.state(() => {
    const read: {
      [sessionID: string]: {
        [path: string]: Date | undefined
      }
    } = {}
    const locks = new Map<string, Promise<void>>()
    // Directories another process is changing, see holdDirectories
    const held = new Map<string, Promise<void>>()
    return {
      read,
      locks,
      held,
      // Global write barrier, see acquireBarrier
      barrier: undefined as Promise<void> | undefined,
    }
  })

  export function read(sessionID: string, file: string) {
    log.info("read", { sessionID, file })
    const { read } = state()
    read[sessionID] = read[sessionID] || {}
    // The file system mtime can be later than the current clock (different precision). Take the later one, otherwise
    // editing a file right after a tool wrote it would be flagged as modified since the read.
    const modified = statSync(file, { throwIfNoEntry: false })?.mtime.getTime() ?? 0
    read[sessionID][file] = new Date(Math.max(Date.now(), modified))
  }

  export function get(sessionID: string, file: string) {
    return state().read[sessionID]?.[file]
  }

  export async function withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
    const current = state()
    // No new path writes start while a barrier is up; afterwards, queue for this file's lock.
    // There must be no await between here and locks.set, or a barrier could go up in the gap and this write slip past.
    for (;;) {
      if (current.barrier) {
        await current.barrier
        continue
      }
      const holder = heldOver(filepath)
      if (!holder) break
      await holder
    }
    const currentLock = current.locks.get(filepath) ?? Promise.resolve()
    let release: () => void = () => {}
    const nextLock = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = currentLock.then(() => nextLock)
    current.locks.set(filepath, chained)
    await currentLock
    try {
      return await fn()
    } finally {
      release()
      if (current.locks.get(filepath) === chained) {
        current.locks.delete(filepath)
      }
    }
  }

  /**
   * Locks several files: acquires all locks in sorted path order, then runs fn. Prevents lost updates from concurrent
   * multi-file writes; the sorted order rules out deadlocks because every withLocks call acquires in the same order.
   * Meant for tools that write several files at once (no built-in caller yet).
   */
  export async function withLocks<T>(filepaths: string[], fn: () => Promise<T>): Promise<T> {
    const current = state()
    while (current.barrier) await current.barrier
    // Deduplicate and sort so the acquisition order is globally consistent and cannot deadlock
    const unique = [...new Set(filepaths)].sort()
    const release: Array<() => void> = []
    // Acquire one by one; if any acquisition fails, the locks already held are released below
    try {
      for (const fp of unique) {
        await acquire(fp, release)
      }
      return await fn()
    } finally {
      for (const r of release.reverse()) r()
    }
  }

  // Acquires one file lock and records its release in bucket; the caller releases everything on failure
  async function acquire(filepath: string, bucket: Array<() => void>) {
    const current = state()
    const currentLock = current.locks.get(filepath) ?? Promise.resolve()
    let release: () => void = () => {}
    const nextLock = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = currentLock.then(() => nextLock)
    current.locks.set(filepath, chained)
    await currentLock
    bucket.push(() => {
      release()
      if (current.locks.get(filepath) === chained) {
        current.locks.delete(filepath)
      }
    })
  }

  /**
   * Acquires the global write barrier and returns its release function.
   *
   * For operations that write files that cannot be known statically. Currently only bash: a command may be `sed -i`,
   * `npm install` or any script, so it cannot be mapped to specific paths and per-path locks do not help. While the
   * barrier is up, all path writes (write / edit / multi_edit) wait, and the barrier itself waits for running path
   * writes to finish, so bash edits and tool edits never interleave and updates are not lost.
   *
   * Read-only commands (git status, ls, grep, etc.) must not use it, or the most common kind of parallelism is lost.
   *
   * No deadlock: a holder of a per-path lock has already passed the barrier check and never waits for the barrier.
   */
  export async function acquireBarrier(): Promise<() => void> {
    const current = state()
    // Barriers are mutually exclusive too, otherwise two writing bash commands would interleave with path writes
    while (current.barrier) await current.barrier
    let release: () => void = () => {}
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    current.barrier = barrier
    // Wait for path writes queued or running before the barrier went up, and for other processes holding directories
    await Promise.allSettled([...current.locks.values(), ...current.held.values()])
    let released = false
    return () => {
      if (released) return
      released = true
      if (current.barrier === barrier) current.barrier = undefined
      release()
    }
  }

  /**
   * Holds directories while another process changes files in them (a coding CLI in a group chat). Path writes under a
   * held directory wait until fn finishes, and so does a write barrier (a bash command may write anywhere); writes
   * elsewhere go on. A hold starts only after a running barrier is released, and registers with no await after that
   * check, so a barrier and a hold never wait for each other.
   */
  export async function holdDirectories<T>(directories: string[], fn: () => Promise<T>): Promise<T> {
    const current = state()
    while (current.barrier) await current.barrier
    let release = () => {}
    const done = new Promise<void>((resolve) => (release = resolve))
    const keys = [...new Set(directories.map((item) => path.resolve(item)))]
    for (const key of keys) current.held.set(key, done)
    // Writes that started before the hold finish first
    await Promise.allSettled(
      keys.flatMap((key) => [...current.locks].filter(([file]) => within(file, key)).map(([, lock]) => lock)),
    )
    try {
      return await fn()
    } finally {
      for (const key of keys) if (current.held.get(key) === done) current.held.delete(key)
      release()
    }
  }

  function heldOver(filepath: string) {
    for (const [directory, done] of state().held) if (within(filepath, directory)) return done
  }

  function within(file: string, directory: string) {
    const relative = path.relative(directory, path.resolve(file))
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }

  export async function assert(sessionID: string, filepath: string) {
    if (Flag.MERAKCODE_DISABLE_FILETIME_CHECK === true) {
      return
    }

    const time = get(sessionID, filepath)
    if (!time) throw new Error(`You must read file ${filepath} before overwriting it. Use the Read tool first`)
    const stats = await fs.stat(filepath)
    if (stats.mtime.getTime() > time.getTime()) {
      throw new Error(
        `File ${filepath} has been modified since it was last read.\nLast modification: ${stats.mtime.toISOString()}\nLast read: ${time.toISOString()}\n\nPlease read the file again before modifying it.`,
      )
    }
  }
}
