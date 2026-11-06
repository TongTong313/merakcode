import { encodeDir, relative } from "../../lib/route"
import { createSignal } from "solid-js"
import z from "zod"
import { persistent } from "../../lib/persistence"
import { releaseFile, retainFile } from "../code/references"
import { buffersFor } from "../code/state"
import { flushDrafts } from "../code/draft"
import {
  flushBrowserOwners,
  releaseBrowserState,
  restoreBrowserOwners,
  retainBrowserState,
  writeBrowserOwner,
} from "../browser/state"
import type { BrowserState } from "../../desktop/bridge-contract"
import { hasTerminals, promoteTerminal, stopTerminal } from "../terminal/resource"
import { bridge } from "../../lib/bridge"
import { resolveDirectory } from "../../state/git"
import { createPanels, type Panels, type PanelTab } from "./state"
import { releaseReview } from "../review/state"
import { releaseReviewDrafts } from "../review/compose"

type Context = { directory: string; sessionID?: string }
const snapshotSchema = z
  .object({
    version: z.literal(1),
    tabs: z.array(
      z
        .object({ id: z.string(), kind: z.string(), url: z.string().optional(), title: z.string().optional() })
        .passthrough(),
    ),
  })
  .passthrough()
type Transfer = {
  source: Panels
  sourceContext: Context
  target: Context
  snapshot?: z.infer<typeof snapshotSchema>
  recorded?: boolean
  running?: Promise<void>
}
const transferSchema = z.object({
  version: z.literal(1),
  sourceContext: z.object({ directory: z.string() }),
  target: z.object({ directory: z.string(), sessionID: z.string() }),
  snapshot: snapshotSchema,
})
const ownerOf = (value: Context) => value.sessionID ?? `new:${value.directory}`
const bucketOf = (value: Context) => `panels-${encodeDir(ownerOf(value))}`
const cache = new Map<string, Panels>()
const failed = new Set<Panels>()
const transfers = new Map<string, Transfer>()
let transfersRestored = false
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
  const raw = await persistent.get(bucketOf(target), "layout")
  const directories = new Set<string>()
  try {
    for (const tab of JSON.parse(raw ?? "null")?.tabs ?? [])
      if (tab.kind === "file")
        directories.add(typeof tab.fileDirectory === "string" ? tab.fileDirectory : target.directory)
  } catch {}
  await Promise.all([...directories].map(resolveDirectory))
  let result: Panels | undefined
  result = await createPanels(
    owner,
    {
      get: async () => raw,
      set: async (_key, value) => {
        try {
          await persistent.set(bucketOf(target), "layout", value)
          if (result) failed.delete(result)
        } catch (error) {
          if (result) failed.add(result)
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
      hasTerminals(state) ||
      [...transfers.values()].some((transfer) => transfer.source === state || ownerOf(transfer.target) === key)
    )
      continue
    await state.flush()
    cache.delete(key)
  }
  return result
}

async function persistBrowser(target: Context, update: BrowserState, active: () => boolean) {
  if (!active()) return
  if (!transfersRestored) await restoreTransfers()
  const owner = await loadPanels(target)
  if (!active()) return
  const tab = owner.state.tabs.find((tab) => tab.id === update.id && tab.kind === "browser")
  if (!tab) return
  const transfer = [...transfers.values()].find(
    (value) =>
      (ownerOf(value.sourceContext) === ownerOf(target) || ownerOf(value.target) === ownerOf(target)) &&
      value.snapshot?.tabs.some((tab) => tab.id === update.id && tab.kind === "browser"),
  )
  if (transfer?.snapshot)
    await recordTransfer(transfer, {
      ...transfer.snapshot,
      tabs: transfer.snapshot.tabs.map((tab) =>
        tab.id === update.id ? { ...tab, url: update.url, title: update.title } : tab,
      ),
    })
  if (active() && (tab.url !== update.url || tab.title !== update.title))
    await owner.patch(tab.id, { url: update.url, title: update.title })
}

restoreBrowserOwners((update, active) =>
  enqueue(async () => {
    const raw = await persistent.get("browser-owners", update.id)
    if (!raw || !active()) return
    const target = JSON.parse(raw) as Context
    if (
      typeof target.directory !== "string" ||
      (target.sessionID !== undefined && typeof target.sessionID !== "string")
    )
      return
    await persistBrowser(target, update, active)
  }),
)

async function retainBrowser(target: Context, id: string) {
  retainBrowserState(id, (update, active) => enqueue(() => persistBrowser(target, update, active)))
  await writeBrowserOwner(id, JSON.stringify(target))
}

async function retainFiles(target: Context, state: Panels) {
  for (const tab of state.state.tabs) {
    if (tab.kind === "file" && tab.path)
      await retainFile(tab.fileDirectory ?? target.directory, tab.path, ownerOf(target))
    if (tab.kind === "browser") await retainBrowser(target, tab.id)
  }
}

async function recordTransfer(transfer: Transfer, snapshot = transfer.snapshot!) {
  await persistent.set(
    "panel-transfers",
    transfer.target.sessionID!,
    JSON.stringify({ version: 1, sourceContext: transfer.sourceContext, target: transfer.target, snapshot }),
  )
  transfer.snapshot = snapshot
  transfer.recorded = true
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
    if (!transfer.recorded) await recordTransfer(transfer)
    const destination = await loadPanels(transfer.target)
    await destination.adopt(transfer.snapshot)
    for (const tab of transfer.snapshot!.tabs) {
      if (tab.kind !== "browser") continue
      const existing = destination.state.tabs.find((item) => item.id === tab.id)
      if (existing && (existing.url !== tab.url || existing.title !== tab.title))
        await destination.patch(tab.id, { url: tab.url, title: tab.title })
    }
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
    await persistent.remove("panel-transfers", transfer.target.sessionID!)
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

async function restoreTransfers() {
  for (const [, raw] of await persistent.entries("panel-transfers")) {
    const stored = transferSchema.parse(JSON.parse(raw))
    if (transfers.has(stored.target.sessionID)) continue
    transfers.set(stored.target.sessionID, {
      ...stored,
      source: await loadPanels(stored.sourceContext),
      recorded: true,
    })
  }
  transfersRestored = true
}

async function flush() {
  await restoreTransfers()
  await flushBrowserOwners()
  for (const state of new Set([...cache.values(), ...failed])) await state.flush()
  for (const transfer of [...transfers.values()]) await complete(transfer)
}

export async function flushPanels() {
  for (;;) {
    const result = enqueue(flush)
    const current = queue
    await result
    if (queue === current) return
  }
}

/** A successful first submission explicitly promotes the draft editor; merely visiting an old chat never does. */
export function promotePanels(directory: string, target: Context) {
  return enqueue(async () => {
    if (!target.sessionID) return
    await flush()
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
    await resolveDirectory(directory)
    input = { ...input, fileDirectory: directory, path: relative(directory, input.path) }
  }
  if (input.kind === "terminal") input = { ...input, ptyDirectory: input.ptyDirectory ?? target.directory }
  const id = result.open(input, reuse)
  if (id && input.kind === "browser") await retainBrowser(target, id)
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
        if (tab.kind === "terminal") await stopTerminal(tab, target.directory)
        if (tab.kind === "browser" && bridge && !(await bridge.browserClose(tab.id))) throw new Error("MRK-7013")
        if (tab.kind === "browser") await releaseBrowserState(tab.id)
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
