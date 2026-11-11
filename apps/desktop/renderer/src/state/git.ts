import type { VcsBranchOptions } from "@merakcode/sdk/client"
import { isMerakCodeError } from "@merakcode/sdk/errors"
import { createStore } from "solid-js/store"
import { t } from "../i18n"
import { call, client } from "./client"
import { restoreDraftProtection } from "../features/code/draft"
import { restoreReviewProtection } from "../features/review/protection"
import { confirmDirectory } from "../features/code/identity"

type Checkout = NonNullable<VcsBranchOptions["current"]>
type Entry = { options?: VcsBranchOptions; loading: boolean; switching: boolean; error?: GitOperationError }
type Change = { branch: string | null; head: string | null; checkout: string | null; branchChanged: boolean }
type BranchRequest = { id: number; pending?: Promise<VcsBranchOptions | undefined> }
const [entries, setEntries] = createStore<Record<string, Entry>>({})
const [identities, setIdentities] = createStore<Record<string, Checkout | null>>({})
const [dirty, setDirty] = createStore<Record<string, Record<string, number>>>({})
const [aliases, setAliases] = createStore<Record<string, string>>({})
const revisions = new Map<string, number>()
const requests = new Map<string, BranchRequest>()
let nextRequest = 0
const listeners = new Set<(directory: string, change: Change) => void>()

class GitOperationError extends Error {}

/** Stable SDK codes and structured reasons select UI copy; the original Git output remains inspectable. */
export function gitFailure(error: unknown) {
  if (error instanceof GitOperationError) return error
  const raw = error instanceof Error ? error.message : String(error)
  let message = raw
  if (isMerakCodeError(error)) {
    if (error.code === "MRK-7006") {
      const reasons = {
        not_git: "git.blocked.not_git",
        unborn: "git.blocked.unborn",
        managed_worktree: "git.blocked.managed_worktree",
        dirty: "git.blocked.dirty",
        busy: "git.blocked.busy",
        git_operation: "git.blocked.git_operation",
        occupied: "git.occupied",
      } as const
      const reason =
        error.data && typeof error.data === "object" && "reason" in error.data ? error.data.reason : undefined
      message =
        typeof reason === "string" && Object.hasOwn(reasons, reason)
          ? t(reasons[reason as keyof typeof reasons])
          : t("git.blocked.generic")
    }
    if (error.code === "MRK-7007") message = t("git.invalidBranch")
    if (error.code === "MRK-7008") message = `${t("git.switchFailed")} ${raw}`
    if (error.code === "MRK-7009") message = t("git.contextChanged")
  }
  return new GitOperationError(message, { cause: error })
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

/** Resolve the checkout root without recursively restoring editor drafts. */
export async function resolveDirectory(directory: string) {
  if (aliases[directory]) return aliases[directory]
  const options = await call(client(directory).vcs.branchOptions())
  await confirmDirectory(directory, options)
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

export function refreshBranches(
  directory: string,
  options?: { force?: boolean },
): Promise<VcsBranchOptions | undefined> {
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

async function loadBranches(directory: string, request: BranchRequest): Promise<VcsBranchOptions | undefined> {
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
    const options = await call(client(directory).vcs.branchOptions())
    await confirmDirectory(directory, options)
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
      (current?.checkout !== before && options.current?.checkout !== current?.checkout)
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
    updateCheckout(target, options.current)
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

export const switching = (directory: string) => !!gitState(directory)?.switching

export function switchReason(directory: string) {
  const local = unsavedReason(directory)
  if (local) return local
  const entry = gitState(directory)
  if (entry?.error) return entry.error.message
  if (!entry?.options || entry.loading) return t("git.loading")
  const blocked = gitState(directory)?.options?.blocked
  if (blocked) return t(`git.blocked.${blocked.reason}`)
}

export async function switchBranch(directory: string, branch: string) {
  if (switching(directory)) return
  const key = gitDirectory(directory)
  setEntries(key, (previous) => ({ ...previous, loading: previous?.loading ?? false, switching: true }))
  try {
    const options = await refreshBranches(directory)
    if (!options?.current) return
    const reason = switchReason(directory)
    if (reason) throw new GitOperationError(reason)
    const result = await call(
      client(directory).vcs.switchBranch({ branch, expectedCheckout: options.current.checkout }),
    )
    const observed = checkoutOf(directory)
    if (observed !== options.current.checkout && observed !== result.checkout)
      throw new GitOperationError(t("git.contextChanged"))
    updateCheckout(key, result)
    await refreshBranches(directory)
    return result
  } catch (error) {
    // A failed transport may still have completed the operation. Read reality before offering a retry.
    await refreshBranches(directory)
    throw gitFailure(error)
  } finally {
    setEntries(key, "switching", false)
    if (gitDirectory(directory) !== key) setEntries(gitDirectory(directory), "switching", false)
  }
}
