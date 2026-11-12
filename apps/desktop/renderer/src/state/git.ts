import type { GitBranch } from "@merakcode/sdk"
import { createStore } from "solid-js/store"
import { t } from "../i18n"
import { sameDir } from "../lib/route"
import { client } from "./client"
import { codeOf } from "./error"
import { restoreDraftProtection } from "../features/code/draft"
import { restoreReviewProtection } from "../features/review/protection"
import { confirmDirectory } from "../features/code/identity"
import { busy, listen, state as engineState } from "./store"

type Checkout = { branch: string | null; head: string | null; checkout: string | null }
type BlockedReason = "not_git" | "unborn" | "managed_worktree" | "busy"
export type BranchOptions = {
  /** The canonical form of the directory that was asked about */
  directory: string
  current: Checkout
  branches: (GitBranch & { worktree?: string })[]
  blocked?: { reason: BlockedReason }
}
type Entry = { options?: BranchOptions; loading: boolean; switching: boolean; error?: GitOperationError }
type Change = Checkout & { branchChanged: boolean }
type BranchRequest = { id: number; pending?: Promise<BranchOptions | undefined> }
const [entries, setEntries] = createStore<Record<string, Entry>>({})
const [identities, setIdentities] = createStore<Record<string, Checkout | null>>({})
const [dirty, setDirty] = createStore<Record<string, Record<string, number>>>({})
const [aliases, setAliases] = createStore<Record<string, string>>({})
const revisions = new Map<string, number>()
const requests = new Map<string, BranchRequest>()
let nextRequest = 0
const listeners = new Set<(directory: string, change: Change) => void>()

class GitOperationError extends Error {}

/** Stable engine codes select UI copy; the original failure remains inspectable. */
export function gitFailure(error: unknown) {
  if (error instanceof GitOperationError) return error
  const raw = error instanceof Error ? error.message : String(error)
  return new GitOperationError(codeOf(error) ? `${t("git.switchFailed")} ${raw}` : raw, { cause: error })
}

export const gitDirectory = (directory: string) => aliases[directory] ?? directory
export const gitState = (directory: string) => entries[gitDirectory(directory)]
export const checkoutOf = (directory: string) => identities[gitDirectory(directory)]?.checkout
export const identityOf = (directory: string) => identities[gitDirectory(directory)]

/** Compare confirmed aliases without guessing whether a filesystem folds case. */
export function sameDirectory(a: string, b: string) {
  const normalize = (value: string) =>
    gitDirectory(value)
      .replace(/\\/g, "/")
      .replace(/(.)\/+$/, "$1")
  return normalize(a) === normalize(b)
}

/** Reads the canonical form of a directory and the repository checkout it holds. */
async function lookup(directory: string) {
  const connection = await client()
  const identity = await connection.file.identity({ directory, path: "." })
  if (!identity.root) return { directory: identity.directory, branches: [], worktrees: [], managed: false }
  const [status, branches, worktrees] = await Promise.all([
    connection.repo.status({ directory: identity.directory }),
    connection.repo.branches({ directory: identity.directory }),
    connection.worktree.list({ directory: identity.directory }).catch(() => []),
  ])
  return {
    directory: identity.directory,
    status,
    branches: branches ?? [],
    worktrees: worktrees ?? [],
    managed: !!identity.worktree,
  }
}

function optionsOf(result: Awaited<ReturnType<typeof lookup>>): BranchOptions {
  const { directory, status } = result
  if (!status)
    return {
      directory,
      current: { branch: null, head: null, checkout: null },
      branches: [],
      blocked: { reason: "not_git" },
    }
  const current = {
    branch: status.branch || null,
    head: status.head || null,
    checkout: `${status.branch}:${status.head}`,
  }
  const trees = result.worktrees ?? []
  const used = new Map(trees.map((tree) => [tree.branch, tree.path]))
  const branches = result.branches.map((branch) => {
    const path = used.get(branch.name)
    return path && !branch.current ? { ...branch, worktree: path } : branch
  })
  const working = engineState.sessions.some((info) => sameDir(info.config.workdir, directory) && busy(info.id))
  const blocked: BranchOptions["blocked"] = !status.head
    ? { reason: "unborn" }
    : result.managed
      ? { reason: "managed_worktree" }
      : working
        ? { reason: "busy" }
        : undefined
  return { directory, current, branches, ...(blocked ? { blocked } : {}) }
}

/** Resolve the checkout root without recursively restoring editor drafts. */
export async function resolveDirectory(directory: string) {
  if (aliases[directory]) return aliases[directory]
  const options = optionsOf(await lookup(directory))
  await confirmDirectory(directory, options.directory)
  associate(directory, options.directory)
  return options.directory
}

/** Editor buffers and comment drafts outlive their views, and register their own unsaved work. */
export function registerDirty(directory: string, owner: string, count: number) {
  const key = gitDirectory(directory)
  if (count > 0) return void setDirty(key, (previous) => ({ ...previous, [owner]: count }))
  if (dirty[key]) setDirty(key, owner, undefined!)
}

export function unsavedReason(directory: string) {
  const counts = dirty[gitDirectory(directory)] ?? {}
  if (Object.entries(counts).some(([owner, count]) => owner.startsWith("editor:") && count > 0))
    return t("git.blocked.editor")
  if (Object.values(counts).some((count) => count > 0)) return t("git.blocked.comments")
}

export function onCheckoutChange(listener: (directory: string, change: Change) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Tokens are opaque: observations are ordered locally, never compared lexicographically. */
export function updateCheckout(directory: string, current: Checkout | null, branchChanged?: boolean) {
  const key = gitDirectory(directory)
  const before = identities[key]
  const previousBranch = before?.branch
  if (before?.checkout === current?.checkout && before !== undefined) {
    setIdentities(key, current)
    return
  }
  revisions.set(key, (revisions.get(key) ?? 0) + 1)
  setIdentities(key, current)
  const change = {
    branch: current?.branch ?? null,
    head: current?.head ?? null,
    checkout: current?.checkout ?? null,
    branchChanged: branchChanged ?? (before !== undefined && previousBranch !== current?.branch),
  }
  for (const listener of listeners) listener(key, change)
}

/** Associates a route alias with the checkout directory confirmed by the engine. */
function associate(directory: string, canonical: string) {
  if (directory !== canonical && identities[directory] && !identities[canonical]) {
    setIdentities(canonical, identities[directory])
    revisions.set(canonical, Math.max(revisions.get(directory) ?? 0, revisions.get(canonical) ?? 0))
  }
  if (directory !== canonical && entries[directory] && !entries[canonical]) setEntries(canonical, entries[directory])
  setAliases(directory, canonical)
  for (const [alias, target] of Object.entries(aliases)) {
    if (target !== canonical && alias !== directory) continue
    setAliases(alias, canonical)
    const counts = dirty[alias]
    if (counts && alias !== canonical) {
      setDirty(canonical, (previous) =>
        Object.fromEntries(
          [...new Set([...Object.keys(previous ?? {}), ...Object.keys(counts)])].map((owner) => [
            owner,
            Math.max(previous?.[owner] ?? 0, counts[owner] ?? 0),
          ]),
        ),
      )
      setDirty(alias, {})
    }
  }
}

export function refreshBranches(directory: string, options?: { force?: boolean }): Promise<BranchOptions | undefined> {
  const key = gitDirectory(directory)
  const active = requests.get(key)?.pending
  // Opening the picker must not reuse a lookup that started before an out-of-band `git branch` create.
  if (active && !options?.force) return active
  const request: BranchRequest = { id: ++nextRequest }
  requests.set(key, request)
  request.pending = loadBranches(directory, request).finally(() => {
    if (requests.get(key) === request) request.pending = undefined
  })
  return request.pending
}

async function loadBranches(directory: string, request: BranchRequest): Promise<BranchOptions | undefined> {
  const key = gitDirectory(directory)
  const revision = revisions.get(key) ?? 0
  const before = checkoutOf(directory)
  setEntries(key, (previous) => ({
    ...previous,
    loading: true,
    switching: previous?.switching ?? false,
    error: undefined,
  }))
  try {
    const options = optionsOf(await lookup(directory))
    await confirmDirectory(directory, options.directory)
    const next = requests.get(key)
    if (next && next.id > request.id) return next.pending ?? gitState(key)?.options
    const targetKey = gitDirectory(options.directory)
    const targetRequest = requests.get(targetKey)
    if (targetRequest && targetRequest.id > request.id) {
      associate(directory, options.directory)
      return targetRequest.pending ?? gitState(targetKey)?.options
    }
    const current = identities[targetKey] ?? identities[key]
    if (
      (revisions.get(key) ?? 0) !== revision ||
      (current?.checkout !== before && options.current.checkout !== current?.checkout)
    )
      return loadBranches(directory, request)
    associate(directory, options.directory)
    const target = gitDirectory(directory)
    requests.set(target, request)
    await restoreDraftProtection(directory)
    if (target !== directory) await restoreDraftProtection(target)
    await restoreReviewProtection(target)
    const latest = requests.get(target)
    if (latest && latest.id > request.id) return latest.pending ?? gitState(target)?.options
    if ((revisions.get(key) ?? 0) !== revision) return loadBranches(directory, request)
    updateCheckout(target, options.blocked?.reason === "not_git" ? null : options.current)
    setEntries(target, (previous) => ({
      ...previous,
      options,
      loading: false,
      switching: previous?.switching ?? false,
      error: undefined,
    }))
    return options
  } catch (error) {
    const target = gitDirectory(directory)
    if (requests.get(key) === request && (requests.get(target)?.id ?? 0) <= request.id)
      setEntries(target, { loading: false, error: gitFailure(error) })
  }
}

// A checkout changed outside the app (a terminal, another tool) is noticed through the repository events
listen((directory, event) => {
  if (event.type !== "repo.changed") return
  for (const known of Object.keys(identities)) if (sameDir(known, directory)) void refreshBranches(known)
})

export const switching = (directory: string) => !!gitState(directory)?.switching

export function switchReason(directory: string) {
  const local = unsavedReason(directory)
  if (local) return local
  const entry = gitState(directory)
  if (entry?.error) return entry.error.message
  if (!entry?.options || entry.loading) return t("git.loading")
  const blocked = entry.options.blocked
  if (blocked) return t(`git.blocked.${blocked.reason}`)
}

export async function switchBranch(directory: string, branch: string) {
  if (switching(directory)) return
  const key = gitDirectory(directory)
  setEntries(key, (previous) => ({ ...previous, loading: previous?.loading ?? false, switching: true }))
  try {
    const options = await refreshBranches(directory, { force: true })
    if (!options) return
    const reason = switchReason(directory)
    if (reason) throw new GitOperationError(reason)
    if (!options.branches.some((known) => known.name === branch)) throw new GitOperationError(t("git.invalidBranch"))
    await (await client()).repo.checkout({ directory: options.directory, branch })
    return (await refreshBranches(directory, { force: true }))?.current
  } catch (error) {
    // A failed transport may still have completed the operation. Read reality before offering a retry.
    await refreshBranches(directory, { force: true })
    throw gitFailure(error)
  } finally {
    setEntries(key, "switching", false)
    if (gitDirectory(directory) !== key) setEntries(gitDirectory(directory), "switching", false)
  }
}
