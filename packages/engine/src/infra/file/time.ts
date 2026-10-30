import fs from "fs/promises"
import path from "path"
import { statSync, realpathSync } from "fs"
import { Instance } from "../project/instance"
import { Log } from "@merakcode/log/logger"
import { Flag } from "../flag/flag"

export namespace FileTime {
  const log = Log.create({ service: "file.time" })
  type WriteState = {
    locks: Map<string, Promise<void>>
    held: Map<string, Promise<void>>
    barrier?: Promise<void>
  }
  const coordination = new Map<string, WriteState>()
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
    // Single-root and multi-root views of the same directory share physical writes, but not session read times.
    const key = canonical(Instance.directory)
    const shared: WriteState = coordination.get(key) ?? { locks: new Map(), held: new Map() }
    coordination.set(key, shared)
    return {
      read,
      locks: shared.locks,
      held: shared.held,
      get barrier() {
        return shared.barrier
      },
      set barrier(value: Promise<void> | undefined) {
        shared.barrier = value
      },
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

  export async function withLock<T>(filepath: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await acquireFiles([filepath], signal)
    try {
      signal?.throwIfAborted()
      return await fn()
    } finally {
      release()
    }
  }

  /**
   * Locks several files: acquires all locks in sorted path order, then runs fn. Prevents lost updates from concurrent
   * multi-file writes; the sorted order rules out deadlocks because every withLocks call acquires in the same order.
   * Meant for tools that write several files at once (no built-in caller yet).
   */
  export async function withLocks<T>(filepaths: string[], fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await acquireFiles(filepaths, signal)
    try {
      signal?.throwIfAborted()
      return await fn()
    } finally {
      release()
    }
  }

  async function acquireFiles(filepaths: string[], signal?: AbortSignal) {
    const current = state()
    const keys = [...new Set(filepaths.map(canonical))].sort()
    for (;;) {
      signal?.throwIfAborted()
      const ahead = current.barrier ? [current.barrier] : keys.flatMap((key) => heldOver(key) ?? [])
      if (!ahead.length) break
      await waiting(Promise.all(ahead), signal)
    }
    const done = Promise.withResolvers<void>()
    const locks = keys.map((key) => {
      const previous = current.locks.get(key) ?? Promise.resolve()
      const chained = previous.then(() => done.promise)
      current.locks.set(key, chained)
      return { key, previous, chained }
    })
    const release = () => {
      done.resolve()
      for (const { key, chained } of locks)
        void chained.then(() => {
          if (current.locks.get(key) === chained) current.locks.delete(key)
        })
    }
    try {
      await waiting(Promise.all(locks.map(({ previous }) => previous)), signal)
      signal?.throwIfAborted()
      return release
    } catch (error) {
      release()
      throw error
    }
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
  export async function acquireBarrier(signal?: AbortSignal): Promise<() => void> {
    const current = state()
    // Barriers are mutually exclusive too, otherwise two writing bash commands would interleave with path writes
    while (current.barrier) await waiting(current.barrier, signal)
    signal?.throwIfAborted()
    let release: () => void = () => {}
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    current.barrier = barrier
    // Wait for path writes queued or running before the barrier went up, and for other processes holding directories
    let released = false
    const finish = () => {
      if (released) return
      released = true
      if (current.barrier === barrier) current.barrier = undefined
      release()
    }
    try {
      await waiting(Promise.allSettled([...current.locks.values(), ...current.held.values()]), signal)
      signal?.throwIfAborted()
      return finish
    } catch (error) {
      finish()
      throw error
    }
  }

  /**
   * Holds directories while another process changes files in them (a coding CLI in a group chat). Path writes under a
   * held directory wait until fn finishes, and so does a write barrier (a bash command may write anywhere); writes
   * elsewhere go on. A hold starts only after a running barrier is released, and registers with no await after that
   * check, so a barrier and a hold never wait for each other.
   */
  export async function holdDirectories<T>(
    directories: string[],
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const current = state()
    const keys = [...new Set(directories.map(canonical))]
    for (;;) {
      signal?.throwIfAborted()
      const ahead = current.barrier
        ? [current.barrier]
        : [...current.held]
            .filter(([held]) => keys.some((key) => within(key, held) || within(held, key)))
            .map(([, done]) => done)
      if (!ahead.length) break
      await waiting(Promise.all(ahead), signal)
    }
    let release = () => {}
    const done = new Promise<void>((resolve) => (release = resolve))
    for (const key of keys) current.held.set(key, done)
    // Writes that started before the hold finish first
    try {
      await waiting(
        Promise.allSettled(
          keys.flatMap((key) => [...current.locks].filter(([file]) => within(file, key)).map(([, lock]) => lock)),
        ),
        signal,
      )
      signal?.throwIfAborted()
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
    const relative = path.relative(canonical(directory), canonical(file))
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }

  function canonical(filepath: string) {
    let directory = path.resolve(filepath)
    const missing: string[] = []
    for (;;) {
      try {
        directory = path.join(realpathSync.native(directory), ...missing.reverse())
        break
      } catch {
        const parent = path.dirname(directory)
        if (parent === directory) break
        missing.push(path.basename(directory))
        directory = parent
      }
    }
    return process.platform === "win32" ? directory.toLowerCase() : directory
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
