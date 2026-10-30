import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import path from "node:path"
import z from "zod"
import { NamedError } from "@merakcode/util/error"
import { Log } from "@merakcode/log/logger"
import { Process } from "@merakcode/util/process"
import { Instance } from "./instance"

export namespace Checkout {
  export type Identity = {
    directory: string
    branch: string | null
    head: string | null
    checkout: string
  }

  export const BlockedError = NamedError.create(
    "CheckoutBlockedError",
    z.object({
      reason: z.enum(["not_git", "unborn", "managed_worktree", "dirty", "busy", "git_operation", "occupied"]),
      message: z.string(),
      branch: z.string().optional(),
      worktree: z.string().optional(),
      operation: z.string().optional(),
      staged: z.number().int().optional(),
      unstaged: z.number().int().optional(),
      untracked: z.number().int().optional(),
    }),
  )
  export const StaleError = NamedError.create(
    "CheckoutStaleError",
    z.object({
      message: z.string(),
      expectedCheckout: z.string().nullable(),
      checkout: z.string().nullable(),
    }),
  )

  type Listener = (next: Identity | null, previous: Identity | null) => void
  type Entry = {
    directory: string
    activities: number
    exclusive: boolean
    observed: boolean
    generation: number
    identity: Identity | null
    reading: Promise<void>
    listeners: Set<Listener>
  }

  const log = Log.create({ service: "checkout" })
  const nonce = randomUUID()
  const entries = new Map<string, Entry>()

  function entry(directory = Instance.worktree) {
    const absolute = path.resolve(directory === "/" && Instance.has() ? Instance.directory : directory)
    const real = (() => {
      try {
        return realpathSync.native(absolute)
      } catch {
        return absolute
      }
    })()
    const normalized = path.normalize(real)
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized
    const known = entries.get(key)
    if (known) return known
    const next: Entry = {
      directory: normalized,
      activities: 0,
      exclusive: false,
      observed: false,
      generation: 0,
      identity: null,
      reading: Promise.resolve(),
      listeners: new Set(),
    }
    entries.set(key, next)
    return next
  }

  export function sameDirectory(left: string, right: string): boolean {
    return entry(left) === entry(right)
  }

  /** The directory is a checkout root, not an arbitrary command's working subdirectory. */
  export function hold(directory = Instance.worktree): () => void {
    const current = entry(directory)
    if (current.exclusive) throw new BlockedError({ reason: "busy", message: "The checkout is switching branches" })
    current.activities++
    let released = false
    return () => {
      if (released) return
      released = true
      current.activities--
    }
  }

  export async function activity<T>(task: () => T | Promise<T>, directory = Instance.worktree): Promise<T> {
    const release = hold(directory)
    try {
      return await task()
    } finally {
      release()
    }
  }

  export async function exclusive<T>(task: () => T | Promise<T>, directory = Instance.worktree): Promise<T> {
    const current = entry(directory)
    if (current.exclusive || current.activities)
      throw new BlockedError({ reason: "busy", message: "The checkout has an operation in progress" })
    current.exclusive = true
    try {
      return await task()
    } finally {
      current.exclusive = false
    }
  }

  export function busy(directory = Instance.worktree): boolean {
    const current = entry(directory)
    return current.exclusive || current.activities > 0
  }

  export function subscribe(listener: Listener, directory = Instance.worktree): () => void {
    const current = entry(directory)
    const bound = AsyncLocalStorage.bind(listener)
    current.listeners.add(bound)
    return () => current.listeners.delete(bound)
  }

  /** Serial reads prevent a slower old observation from moving the generation backwards. */
  export async function current(directory = Instance.worktree): Promise<Identity | null> {
    const current = entry(directory)
    const read = current.reading.then(async () => {
      const result = await Process.run(
        ["git", "status", "--porcelain=v2", "--branch", "--untracked-files=no", "--ignore-submodules=all"],
        {
          cwd: current.directory,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
          nothrow: true,
        },
      ).catch(() => undefined)
      const raw = result?.exitCode === 0 ? result.text() : undefined
      const name = raw?.match(/^# branch\.head (.+)\r?$/m)?.[1]?.trim()
      const oid = raw?.match(/^# branch\.oid (.+)\r?$/m)?.[1]?.trim()
      const branch = name && name !== "(detached)" ? name : null
      const head = oid && oid !== "(initial)" ? oid : null
      const previous = current.identity
      const exists = raw !== undefined && name !== undefined
      const changed = exists ? !previous || previous.branch !== branch || previous.head !== head : previous !== null
      if (!current.observed || changed) {
        current.generation++
        current.identity = exists
          ? {
              directory: current.directory,
              branch,
              head,
              checkout: createHash("sha256")
                .update(JSON.stringify([nonce, current.directory, current.generation, branch, head]))
                .digest("hex"),
            }
          : null
        const publish = current.observed && changed
        current.observed = true
        if (publish)
          for (const listener of current.listeners) {
            try {
              listener(current.identity, previous)
            } catch (error) {
              log.error("checkout listener failed", { error })
            }
          }
      }
      return current.identity
    })
    current.reading = read.then(
      () => {},
      () => {},
    )
    return read
  }

  export async function assert(
    expectedCheckout: string | null,
    directory = Instance.worktree,
  ): Promise<Identity | null> {
    const identity = await current(directory)
    const checkout = identity?.checkout ?? null
    if (checkout !== expectedCheckout)
      throw new StaleError({ message: "The checkout changed after it was read", expectedCheckout, checkout })
    return identity
  }
}
