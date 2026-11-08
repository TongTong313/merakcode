import type { GitBranch } from "@merakcode/sdk"
import { createStore } from "solid-js/store"
import { t } from "../i18n"
import { client } from "./client"

type Checkout = { branch: string | null; head: string | null; checkout: string | null }
type Options = { branches: GitBranch[]; current: Checkout }
type Entry = { options?: Options; loading: boolean; switching: boolean; error?: Error }
type Change = Checkout & { branchChanged: boolean }
const [entries, setEntries] = createStore<Record<string, Entry>>({})
const [identities, setIdentities] = createStore<Record<string, Checkout | null>>({})
const [dirty, setDirty] = createStore<Record<string, Record<string, number>>>({})
const requests = new Map<string, number>()
const listeners = new Set<(directory: string, change: Change) => void>()
let nextRequest = 0

export const gitDirectory = (directory: string) => directory.replaceAll("\\", "/").replace(/\/$/, "")
export const gitState = (directory: string) => entries[gitDirectory(directory)]
export const identityOf = (directory: string) => identities[gitDirectory(directory)]
export const checkoutOf = (directory: string) => identityOf(directory)?.checkout
export const switching = (directory: string) => !!gitState(directory)?.switching
export const gitFailure = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

export function registerDirty(directory: string, owner: string, count: number) {
  setDirty(gitDirectory(directory), (previous) => ({ ...previous, [owner]: count }))
}
export function unsavedReason(directory: string) {
  if (Object.values(dirty[gitDirectory(directory)] ?? {}).some((count) => count > 0)) return t("git.blocked.comments")
}
export function onCheckoutChange(listener: (directory: string, change: Change) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function updateCheckout(directory: string, current: Checkout | null) {
  const key = gitDirectory(directory)
  const before = identities[key]
  const previousCheckout = before?.checkout
  const previousBranch = before?.branch
  const observed = before !== undefined
  setIdentities(key, current)
  if (previousCheckout === current?.checkout && observed) return
  for (const listener of listeners)
    listener(key, {
      branch: current?.branch ?? null,
      head: current?.head ?? null,
      checkout: current?.checkout ?? null,
      branchChanged: observed && previousBranch !== current?.branch,
    })
}
export async function refreshBranches(directory: string) {
  const key = gitDirectory(directory)
  const request = ++nextRequest
  requests.set(key, request)
  setEntries(key, (previous) => ({
    ...previous,
    loading: true,
    switching: previous?.switching ?? false,
    error: undefined,
  }))
  try {
    const connection = await client()
    const [status, branches] = await Promise.all([
      connection.repo.status({ directory }),
      connection.repo.branches({ directory }),
    ])
    if (requests.get(key) !== request) return
    const current = {
      branch: status.branch || null,
      head: status.head || null,
      checkout: `${status.branch}:${status.head}`,
    }
    const options = { current, branches: branches ?? [] }
    updateCheckout(directory, current)
    setEntries(key, (previous) => ({ ...previous, loading: false, options, error: undefined }))
    return options
  } catch (error) {
    if (requests.get(key) === request) setEntries(key, { loading: false, error: gitFailure(error) })
  }
}
export async function switchBranch(directory: string, branch: string) {
  if (switching(directory)) return
  const key = gitDirectory(directory)
  const reason = unsavedReason(directory)
  if (reason) throw new Error(reason)
  setEntries(key, (previous) => ({ ...previous, loading: previous?.loading ?? false, switching: true }))
  requests.set(key, ++nextRequest)
  try {
    await (await client()).repo.checkout({ directory, branch })
    return (await refreshBranches(directory))?.current
  } catch (error) {
    await refreshBranches(directory)
    throw gitFailure(error)
  } finally {
    setEntries(key, "switching", false)
  }
}
