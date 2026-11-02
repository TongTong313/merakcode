import { encodeDir, relative } from "../../lib/route"
import { createSignal } from "solid-js"
import { persistent } from "../../lib/persistence"
import { releaseFile, retainFile } from "../code/references"
import { buffersFor } from "../code/state"
import { flushDrafts } from "../code/draft"
import { releaseBrowserState } from "../browser/state"
import { promoteTerminal, stopTerminal } from "../terminal/resource"
import { bridge } from "../../lib/bridge"
import { createPanels, type Panels, type PanelTab } from "./state"
import { releaseReview } from "../review/state"
import { releaseReviewDrafts } from "../review/compose"

type Context = { directory: string; sessionID?: string }
type Transfer = { source: Panels; sourceContext: Context; target: Context; snapshot?: unknown; running?: Promise<void> }
const ownerOf = (value: Context) => value.sessionID ?? `new:${value.directory}`
const bucketOf = (value: Context) => `panels-${encodeDir(ownerOf(value))}`
const cache = new Map<string, Panels>()
const failed = new Set<Panels>()
const transfers = new Map<string, Transfer>()
const [currentPanels, setPanels] = createSignal<Panels>()
export const panels = currentPanels
let context: Context | undefined
let pending: Promise<Panels> | undefined
let revision = 0
let queue = Promise.resolve()

function enqueue<T>(run: () => Promise<T>) {
  const result = queue.then(run)
  queue = result.then(
    () => {},
    () => {},
  )
  return result
}

async function loadPanels(target: Context) {
  const owner = ownerOf(target)
  const known = cache.get(owner)
  if (known) {
    cache.delete(owner)
    cache.set(owner, known)
    return known
  }
  const result: Panels = await createPanels(
    owner,
    {
      get: () => persistent.get(bucketOf(target), "layout"),
      set: async (_key, value) => {
        try {
          await persistent.set(bucketOf(target), "layout", value)
          failed.delete(result)
        } catch (error) {
          failed.add(result)
          throw error
        }
      },
    },
    target.directory,
  )
  cache.set(owner, result)
  for (const [key, state] of cache) {
    if (cache.size <= 32) break
    if (
      key === owner ||
      state === panels() ||
      failed.has(state) ||
      [...transfers.values()].some((transfer) => transfer.source === state || ownerOf(transfer.target) === key)
    )
      continue
    await state.flush()
    cache.delete(key)
  }
  return result
}

async function retainFiles(target: Context, state: Panels) {
  for (const tab of state.state.tabs)
    if (tab.kind === "file" && tab.path)
      await retainFile(tab.fileDirectory ?? target.directory, tab.path, ownerOf(target))
}

function complete(transfer: Transfer): Promise<void> {
  if (transfer.running) return transfer.running
  const running = (async () => {
    const source = transfer.source
    source.transfer(true)
    await source.idle()
    await source.flush()
    transfer.snapshot ??= JSON.parse(
      JSON.stringify({
        version: 1,
        ...source.state,
        tabs: source.state.tabs.map((tab) => ({
          ...tab,
          ...(tab.kind === "file" ? { fileDirectory: tab.fileDirectory ?? transfer.sourceContext.directory } : {}),
          ...(tab.kind === "terminal" ? { ptyDirectory: tab.ptyDirectory ?? transfer.sourceContext.directory } : {}),
        })),
      }),
    )
    const destination = await loadPanels(transfer.target)
    await destination.adopt(transfer.snapshot)
    await retainFiles(transfer.target, destination)
    for (const tab of destination.state.tabs)
      if (tab.kind === "terminal") promoteTerminal(tab.id, destination, transfer.target.sessionID)
    for (const tab of source.state.tabs)
      if (tab.kind === "file" && tab.path)
        await releaseFile(
          tab.fileDirectory ?? transfer.sourceContext.directory,
          tab.path,
          ownerOf(transfer.sourceContext),
        )
    await source.retire()
    cache.delete(ownerOf(transfer.sourceContext))
    source.transfer(false)
    transfers.delete(transfer.target.sessionID!)
    if (panels() === source) setPanels(undefined)
  })()
  transfer.running = running
  void running
    .finally(() => {
      transfer.running = undefined
    })
    .catch(() => {})
  return running
}

async function flush() {
  for (const state of new Set([...cache.values(), ...failed])) await state.flush()
  for (const transfer of [...transfers.values()]) await complete(transfer)
}

export async function flushPanels() {
  await queue
  await flush()
}

/** A successful first submission explicitly promotes the draft editor; merely visiting an old chat never does. */
export function promotePanels(directory: string, target: Context) {
  return enqueue(async () => {
    if (!target.sessionID) return
    let transfer = transfers.get(target.sessionID)
    if (!transfer) {
      const sourceContext = { directory }
      transfer = { sourceContext, source: await loadPanels(sourceContext), target }
      transfers.set(target.sessionID, transfer)
    }
    await complete(transfer)
  })
}

export function selectPanels(next: Context) {
  if (next.directory === context?.directory && next.sessionID === context.sessionID && pending) return pending
  const ticket = ++revision
  context = next
  setPanels(undefined)
  pending = enqueue(async () => {
    await flush()
    const result = await loadPanels(next)
    await retainFiles(next, result)
    for (const tab of result.state.tabs) if (tab.kind === "terminal") promoteTerminal(tab.id, result, next.sessionID)
    if (revision === ticket) setPanels(result)
    return result
  }).catch((error: unknown) => {
    if (revision === ticket) pending = undefined
    throw error
  })
  return pending
}

export async function openPanel(input: Omit<PanelTab, "id">, reuse = false) {
  const selected = pending
  const target = context
  const result = await selected
  if (!result || !target) return
  if (input.kind === "file" && input.path) {
    const directory = input.fileDirectory ?? target.directory
    input = { ...input, fileDirectory: directory, path: relative(directory, input.path) }
  }
  if (input.kind === "terminal") input = { ...input, ptyDirectory: input.ptyDirectory ?? target.directory }
  const id = result.open(input, reuse)
  if (id && input.kind === "file" && input.path) {
    const tab = result.state.tabs.find((tab) => tab.id === id)!
    await retainFile(tab.fileDirectory ?? target.directory, tab.path!, ownerOf(target))
  }
}

export function panelContext() {
  return context
}

export function releasePanels(target: Context, deleted = false) {
  return enqueue(async () => {
    const state = await loadPanels(target)
    await flushDrafts()
    const failures: unknown[] = []
    for (const tab of state.state.tabs) {
      try {
        if (tab.kind === "terminal") await stopTerminal(tab, target.directory, target.sessionID)
        if (tab.kind === "browser" && bridge && !(await bridge.browserClose(tab.id))) throw new Error("MRK-7013")
        if (tab.kind === "browser") releaseBrowserState(tab.id)
      } catch (error) {
        failures.push(error)
      }
    }
    await state.update({ visible: false })
    releaseReview(target.directory, target.sessionID, deleted)
    if (deleted && target.sessionID) releaseReviewDrafts(target.directory, target.sessionID)
    if (failures.length) throw failures[0]
    if (!deleted) return
    for (const tab of state.state.tabs) {
      if (tab.kind !== "file" || !tab.path) continue
      const directory = tab.fileDirectory ?? target.directory
      const remaining = await releaseFile(directory, tab.path, ownerOf(target))
      if (!remaining.length) await buffersFor(directory).close(tab.path)
    }
    await state.retire()
    cache.delete(ownerOf(target))
  })
}

export async function togglePanels() {
  const state = await pending
  if (state) await state.update({ visible: !state.state.visible })
}
