import { encodeDir } from "../../lib/route"
import { createSignal } from "solid-js"
import z from "zod"
import { MerakCodeError } from "../../state/error"
import { persistent } from "../../lib/persistence"
import { t } from "../../i18n"
import { fileOwners, releaseFile, retainFile } from "../code/references"
import { buffersFor } from "../code/state"
import { flushDrafts, readDraft } from "../code/draft"
import { resolveFile } from "../code/identity"
import {
  flushBrowserOwners,
  flushBrowserStates,
  releaseBrowserState,
  restoreBrowserOwners,
  retainBrowserState,
  writeBrowserOwner,
} from "../browser/state"
import type { BrowserState } from "../../desktop/bridge-contract"
import { hasTerminals, promoteTerminal, stopTerminal } from "../terminal/resource"
import { bridge, log } from "../../lib/bridge"
import { resolveDirectory } from "../../state/git"
import { client } from "../../state/client"
import { createPanels, parseLayout, type Panels, type PanelTab } from "./state"
import { releaseReview } from "../review/state"
import { releaseReviewDrafts } from "../review/compose"

const contextSchema = z.object({ directory: z.string(), sessionID: z.string().optional() })
type Context = z.infer<typeof contextSchema>
type Promotion = { target: Context; ready?: Promise<void> }
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
  source?: Panels
  sourceContext: Context
  target: Context
  snapshot?: z.infer<typeof snapshotSchema>
  cancelled?: boolean
  recorded?: boolean
  running?: Promise<void>
  checking?: boolean
  cleanup?: Promise<Awaited<ReturnType<typeof prepareCancellation>>>
  recording?: Promise<void>
}
const transferSchema = z.object({
  version: z.literal(1),
  sourceContext: z.object({ directory: z.string() }),
  target: z.object({ directory: z.string(), sessionID: z.string() }),
  snapshot: snapshotSchema,
  cancelled: z.boolean().optional(),
})
const ownerOf = (value: Context) => value.sessionID ?? `new:${value.directory}`
const bucketOf = (value: Context) => `panels-${encodeDir(ownerOf(value))}`
const cache = new Map<string, Panels>()
const loading = new Map<string, Promise<Panels>>()
const failed = new Set<Panels>()
const transfers = new Map<string, Transfer>()
const invalidTransfers = new Map<string, Error>()
let restoring: Promise<void> | undefined
const deletingOwners = new Set<string>()
const deletedOwners = new Set<string>()
let transfersRestored = false
const [currentPanels, setPanels] = createSignal<Panels>()
export const panels = currentPanels
let context: Context | undefined
let pending: Promise<Panels> | undefined
const promotions = new WeakMap<Promise<Panels>, Promotion>()
let revision = 0
let queue = Promise.resolve()
const ownerQueues = new Map<string, Promise<unknown>>()
const openings = new Set<Promise<void>>()
const promotionRecords = new Map<Promise<void>, { owner: string; resolve: () => void }>()

/** Only operations touching the same chat wait for each other's directory recovery. */
function enqueueOwners<T>(targets: Context[], run: () => Promise<T>) {
  const ready = restoreTransfers().then(() => {
    for (const target of targets) {
      const error = invalidTransfers.get(ownerOf(target))
      if (error) throw error
    }
    const owners = new Set(targets.map(ownerOf))
    for (const transfer of transfers.values())
      if (targets.some((target) => ownsTransfer(transfer, target))) {
        owners.add(ownerOf(transfer.sourceContext))
        owners.add(ownerOf(transfer.target))
      }
    const result = Promise.all([...owners].map((owner) => ownerQueues.get(owner))).then(run)
    const settled = result.then(
      () => {},
      () => {},
    )
    for (const owner of owners) ownerQueues.set(owner, settled)
    void settled.then(() => {
      for (const owner of owners) if (ownerQueues.get(owner) === settled) ownerQueues.delete(owner)
    })
    return result
  })
  return ready
}

function enqueue<T>(run: () => Promise<T>) {
  const result = queue.then(run)
  queue = result.then(
    () => {},
    () => {},
  )
  return result
}

async function resolveLayoutFiles(raw: string | null, directory: string) {
  const directories = new Set<string>()
  const files: { directory: string; path: string }[] = []
  for (const tab of parseLayout(raw)?.tabs ?? [])
    if (tab.kind === "file") {
      directories.add(tab.fileDirectory ?? directory)
      if (!tab.planSessionID && tab.path) files.push({ directory: tab.fileDirectory ?? directory, path: tab.path })
    } else if (tab.kind === "review") directories.add(directory)
  await Promise.all([...directories].map(resolveDirectory))
  await Promise.all(files.map((file) => resolveFile(file.directory, file.path)))
}

async function loadPanels(target: Context) {
  const owner = ownerOf(target)
  const known = cache.get(owner)
  if (known) {
    cache.delete(owner)
    cache.set(owner, known)
    return known
  }
  const existing = loading.get(owner)
  if (existing) return existing
  const request = readPanels(target).finally(() => loading.delete(owner))
  loading.set(owner, request)
  return request
}

async function readPanels(target: Context) {
  const owner = ownerOf(target)
  const raw = await persistent.get(bucketOf(target), "layout")
  await resolveLayoutFiles(raw, target.directory)
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
  if (deletedOwners.has(ownerOf(target))) return
  const owner = cache.get(ownerOf(target))
  const raw = owner ? null : await persistent.get(bucketOf(target), "layout")
  // Browser navigation does not need file identity recovery, which may require an offline directory.
  const layout = owner?.state ?? (raw ? snapshotSchema.parse(JSON.parse(raw)) : undefined)
  if (!active()) return
  const tab = layout?.tabs.find((tab) => tab.id === update.id && tab.kind === "browser")
  if (!tab) return
  const transfer = [...transfers.values()].find(
    (value) =>
      (ownerOf(value.sourceContext) === ownerOf(target) || ownerOf(value.target) === ownerOf(target)) &&
      value.snapshot?.tabs.some((tab) => tab.id === update.id && tab.kind === "browser"),
  )
  if (transfer?.cancelled) return
  const title =
    tab.url === update.url && weakBrowserTitle(update.title, update.url) && !weakBrowserTitle(tab.title, tab.url)
      ? tab.title!
      : update.title
  if (transfer?.snapshot)
    await recordTransfer(transfer, {
      ...transfer.snapshot,
      tabs: transfer.snapshot.tabs.map((tab) => (tab.id === update.id ? { ...tab, url: update.url, title } : tab)),
    })
  if (!active() || (tab.url === update.url && tab.title === title)) return
  const patch = { url: update.url, title }
  if (owner) {
    try {
      await owner.patch(tab.id, patch)
    } catch (error) {
      const source = transfer ? cache.get(ownerOf(transfer.sourceContext)) : undefined
      if (!source || source === owner) throw error
      // The destination write failed. The source layout is still the stored copy.
      await source.patch(tab.id, patch)
    }
    return
  }
  await persistent.set(
    bucketOf(target),
    "layout",
    JSON.stringify({
      ...layout,
      tabs: layout!.tabs.map((item) => (item.id === tab.id ? { ...item, url: update.url, title } : item)),
    }),
  )
}

function weakBrowserTitle(title: string | undefined, url: string) {
  if (!title || title === url) return true
  try {
    const parsed = new URL(url)
    return title === `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return false
  }
}

restoreBrowserOwners((update, active) =>
  enqueue(async () => {
    const raw = await persistent.get("browser-owners", update.id)
    if (!raw || !active()) return
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return
    }
    const target = contextSchema.safeParse(value)
    if (!target.success) return
    await persistBrowser(target.data, update, active)
  }),
)

async function retainBrowser(target: Context, id: string) {
  retainBrowserState(id, (update, active) => enqueue(() => persistBrowser(target, update, active)))
  await writeBrowserOwner(id, JSON.stringify(target))
}

async function retainTabs(target: Context, state: Panels) {
  for (const tab of state.state.tabs) {
    if (tab.kind === "file" && tab.path)
      await retainFile(tab.fileDirectory ?? target.directory, tab.path, ownerOf(target))
    if (tab.kind === "browser") await retainBrowser(target, tab.id)
  }
}

async function writeTransfer(transfer: Transfer, write: () => Promise<void>) {
  const recording = (transfer.recording ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (transfers.get(transfer.target.sessionID!) !== transfer) return
      await write()
    })
  transfer.recording = recording
  try {
    await recording
  } finally {
    if (transfer.recording === recording) transfer.recording = undefined
  }
}

function recordTransfer(transfer: Transfer, snapshot = transfer.snapshot!) {
  return writeTransfer(transfer, async () => {
    await persistent.set(
      "panel-transfers",
      transfer.target.sessionID!,
      JSON.stringify({
        version: 1,
        sourceContext: transfer.sourceContext,
        target: transfer.target,
        snapshot,
        cancelled: transfer.cancelled,
      }),
    )
    transfer.snapshot = snapshot
    transfer.recorded = true
    for (const [request, record] of promotionRecords) {
      if (record.owner !== ownerOf(transfer.target)) continue
      record.resolve()
      promotionRecords.delete(request)
    }
  })
}

function removeTransfer(transfer: Transfer, cancelled = false) {
  return writeTransfer(transfer, async () => {
    if (transfer.cancelled && !cancelled) return
    await persistent.remove("panel-transfers", transfer.target.sessionID!)
    transfer.recorded = false
    if (transfer.cancelled && !cancelled) return
    transfers.delete(transfer.target.sessionID!)
  })
}

function snapshotPanels(state: Panels, target: Context): z.infer<typeof snapshotSchema> {
  return JSON.parse(
    JSON.stringify({
      version: 1,
      ...state.state,
      tabs: state.state.tabs.map((tab) => ({
        ...tab,
        ...(tab.kind === "file" ? { fileDirectory: tab.fileDirectory ?? target.directory } : {}),
        ...(tab.kind === "terminal" ? { ptyDirectory: tab.ptyDirectory ?? target.directory } : {}),
      })),
    }),
  )
}

/** A deleted conversation is gone from both the active and the archived list. */
async function sessionExists(sessionID: string) {
  const connection = await client()
  const lists = await Promise.all([connection.session.list({}), connection.session.list({ archived: true })])
  return lists.some((list) => (list ?? []).some((info) => info.id === sessionID))
}

function complete(transfer: Transfer): Promise<void> {
  if (transfer.running) return transfer.running
  const running = (async () => {
    if (!transfer.source && !transfer.cancelled) {
      const knownDeleted = deletedOwners.has(ownerOf(transfer.target))
      if (knownDeleted || !(await sessionExists(transfer.target.sessionID!))) transfer.cancelled = true
    }
    if (transfer.cancelled || deletedOwners.has(ownerOf(transfer.target))) return cancelTransfer(transfer)
    const source = await transferSource(transfer)
    if (transfer.cancelled) return cancelTransfer(transfer)
    source.transfer(true)
    await source.idle()
    await source.flush()
    transfer.snapshot ??= snapshotPanels(source, transfer.sourceContext)
    if (!transfer.recorded) await recordTransfer(transfer)
    const destination = await loadPanels(transfer.target)
    if (transfer.cancelled) return cancelTransfer(transfer)
    await destination.adopt(transfer.snapshot)
    await retainTabs(transfer.target, destination)
    await transfer.recording
    for (const tab of transfer.snapshot!.tabs) {
      if (tab.kind !== "browser") continue
      const existing = destination.state.tabs.find((item) => item.id === tab.id)
      if (existing && (existing.url !== tab.url || existing.title !== tab.title))
        await destination.patch(tab.id, { url: tab.url, title: tab.title })
    }
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
    await removeTransfer(transfer)
    if (transfer.cancelled) return cancelTransfer(transfer)
    cache.delete(ownerOf(transfer.sourceContext))
    source.transfer(false)
    if (panels() === source) setPanels(undefined)
  })()
  transfer.running = running
  void running.catch(() => {
    if (transfer.cancelled) transfer.cleanup = undefined
  })
  void running
    .finally(() => {
      transfer.running = undefined
    })
    .catch(() => {})
  return running
}

async function prepareCancellation(transfer: Transfer) {
  const selected = pending
  transfer.cancelled = true
  deletedOwners.add(ownerOf(transfer.target))
  transfer.source?.transfer(true)
  await transfer.source?.idle()
  await recordTransfer(transfer, transfer.snapshot ?? snapshotPanels(transfer.source!, transfer.sourceContext))
  const source = await transferSource(transfer)
  source.transfer(true)
  await source.idle()
  const destination = await loadPanels(transfer.target)
  destination.transfer(true)
  await destination.idle()
  const tabs = new Map<string, PanelTab>()
  for (const [target, values] of [
    [transfer.sourceContext, parseLayout(JSON.stringify(transfer.snapshot))?.tabs ?? []],
    [transfer.sourceContext, source.state.tabs],
    [transfer.target, destination.state.tabs],
  ] as const)
    for (const tab of values)
      tabs.set(tab.id, {
        ...tab,
        ...(tab.kind === "file" ? { fileDirectory: tab.fileDirectory ?? target.directory } : {}),
        ...(tab.kind === "terminal" ? { ptyDirectory: tab.ptyDirectory ?? target.directory } : {}),
      })
  await recordTransfer(transfer, { version: 1, tabs: [...tabs.values()] })
  await flushDrafts()
  await releaseResources(transfer.target, [...tabs.values()], true)
  for (const tab of tabs.values()) {
    if (tab.kind !== "file" || !tab.path) continue
    const directory = tab.fileDirectory ?? transfer.sourceContext.directory
    await buffersFor(directory).idle(tab.path)
    await fileOwners(directory, tab.path)
    await readDraft(directory, tab.path, { migrate: false })
  }
  return { source, destination, tabs, selected }
}

function cancellation(transfer: Transfer) {
  if (transfer.cleanup) return transfer.cleanup
  const cleanup = prepareCancellation(transfer)
  transfer.cleanup = cleanup
  void cleanup.catch(() => {
    if (transfer.cleanup === cleanup) transfer.cleanup = undefined
  })
  return cleanup
}

async function cancelTransfer(transfer: Transfer) {
  const { source, destination, tabs, selected } = await cancellation(transfer)
  for (const target of [transfer.sourceContext, transfer.target]) {
    releaseReview(target.directory, target.sessionID, true)
    if (target.sessionID) releaseReviewDrafts(target.directory, target.sessionID)
  }
  for (const tab of tabs.values()) {
    if (tab.kind !== "file" || !tab.path) continue
    const directory = tab.fileDirectory ?? transfer.sourceContext.directory
    await releaseFile(directory, tab.path, ownerOf(transfer.sourceContext), "cached")
    const remaining = await releaseFile(directory, tab.path, ownerOf(transfer.target), "cached")
    if (!remaining.length) await buffersFor(directory).close(tab.path, "cached")
  }
  await source.retire()
  await destination.retire()
  cache.delete(ownerOf(transfer.sourceContext))
  const fresh = panels() === source && pending === selected ? await loadPanels(transfer.sourceContext) : undefined
  await removeTransfer(transfer, true)
  cache.delete(ownerOf(transfer.target))
  if (fresh && panels() === source && pending === selected) {
    pending = Promise.resolve(fresh)
    setPanels(fresh)
  }
}

function restoreTransfers() {
  if (restoring) return restoring
  const request = readTransfers().finally(() => {
    if (restoring === request) restoring = undefined
  })
  restoring = request
  return request
}

async function readTransfers() {
  const entries = await persistent.entries("panel-transfers")
  invalidTransfers.clear()
  for (const [key, raw] of entries) {
    if (transfers.has(key) || (await persistent.get("panel-transfers", key)) !== raw) continue
    let value: unknown
    let stored: z.infer<typeof transferSchema>
    try {
      value = JSON.parse(raw)
      stored = transferSchema.parse(value)
      if (stored.target.sessionID !== key) throw new Error("Transfer owner does not match its storage key")
    } catch (cause) {
      const error = new MerakCodeError({ code: "MRK-4026", message: t("panel.restoreError"), cause })
      invalidTransfers.set(key, error)
      const owners = z
        .object({ sourceContext: contextSchema.optional(), target: contextSchema.optional() })
        .safeParse(value)
      if (owners.success)
        for (const target of [owners.data.sourceContext, owners.data.target])
          if (target) invalidTransfers.set(ownerOf(target), error)
      continue
    }
    if (transfers.has(stored.target.sessionID)) continue
    if (stored.cancelled) deletedOwners.add(ownerOf(stored.target))
    transfers.set(stored.target.sessionID, { ...stored, recorded: true })
  }
  transfersRestored = true
}

async function transferSource(transfer: Transfer) {
  if (transfer.source) return transfer.source
  await resolveLayoutFiles(JSON.stringify(transfer.snapshot), transfer.sourceContext.directory)
  transfer.source = await loadPanels(transfer.sourceContext)
  return transfer.source
}

async function recoverTransfers(target: Context) {
  for (const transfer of [...transfers.values()]) if (ownsTransfer(transfer, target)) await complete(transfer)
}

function ownsTransfer(transfer: Transfer, target: Context) {
  const owner = ownerOf(target)
  return ownerOf(transfer.sourceContext) === owner || ownerOf(transfer.target) === owner
}

/** Deleted chats cannot be selected again, so retry their cleanup without awaiting unavailable target lookups. */
function retryCancellations() {
  for (const transfer of transfers.values()) {
    if (!transfer.recorded || transfer.running || transfer.checking) continue
    transfer.checking = true
    void (async () => {
      if (!transfer.cancelled) {
        if (await sessionExists(transfer.target.sessionID!)) return
      }
      await enqueue(async () => {
        if (transfers.get(transfer.target.sessionID!) !== transfer) return
        void cancellation(transfer).catch(() => {})
      })
      await transfer.cleanup
      await enqueue(async () => {
        if (transfers.get(transfer.target.sessionID!) === transfer) await complete(transfer)
      })
    })()
      .catch(() => log("warn", "panel transfer cancellation remains pending", { sessionID: transfer.target.sessionID }))
      .finally(() => {
        transfer.checking = false
      })
  }
}

async function flush(target?: Context) {
  await restoreTransfers()
  if (!target) await flushBrowserOwners()
  const states = target ? [cache.get(ownerOf(target))] : [...cache.values(), ...failed]
  for (const state of new Set(states)) await state?.flush()
  // A durable journal can wait for its own chat to reconnect; shutdown must not query unrelated directories.
  for (const transfer of transfers.values()) {
    if (target && !ownsTransfer(transfer, target)) continue
    await transfer.recording
    if (transfer.recorded) continue
    const source = transfer.source!
    source.transfer(true)
    await source.idle()
    transfer.snapshot ??= snapshotPanels(source, transfer.sourceContext)
    await recordTransfer(transfer)
  }
}

export async function flushPanels() {
  const deadline = Date.now() + 20_000
  for (;;) {
    const pending = Promise.all([...openings, ...promotionRecords.keys()])
    const remaining = deadline - Date.now()
    if (remaining <= 0) return
    await Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, remaining))])
    if (Date.now() >= deadline) return
    await flushBrowserStates()
    const result = enqueue(flush)
    const current = queue
    await Promise.race([
      result,
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
    ])
    if (Date.now() >= deadline) return
    await flushBrowserStates()
    if (openings.size || promotionRecords.size) continue
    // Browser title noise can keep advancing the queue after layouts are durable.
    if (queue === current) return
    await flushBrowserStates()
    if (!openings.size && !promotionRecords.size) return
  }
}

async function promote(directory: string, target: Context) {
  if (!target.sessionID) return
  if (deletedOwners.has(ownerOf(target))) throw new Error(t("panel.persistError"))
  await flush({ directory })
  await recoverTransfers({ directory })
  await flush(target)
  await recoverTransfers(target)
  let transfer = transfers.get(target.sessionID)
  if (!transfer) {
    const sourceContext = { directory }
    transfer = { sourceContext, source: await loadPanels(sourceContext), target }
    transfers.set(target.sessionID, transfer)
  }
  await complete(transfer)
}

function trackPromotion(promotion: Promotion, ready: Promise<void>) {
  promotion.ready = ready
  void ready.catch(() => {
    if (promotion.ready === ready) promotion.ready = undefined
  })
  return ready
}

/** A successful first submission explicitly promotes the draft editor; merely visiting an old chat never does. */
export function promotePanels(directory: string, target: Context) {
  const ready = enqueueOwners([{ directory }, target], () => promote(directory, target))
  const durable = Promise.withResolvers<void>()
  promotionRecords.set(durable.promise, { owner: ownerOf(target), resolve: durable.resolve })
  void ready.then(durable.resolve, durable.reject).finally(() => promotionRecords.delete(durable.promise))
  void durable.promise.catch(() => {})
  const selected = pending
  if (
    target.sessionID &&
    !deletingOwners.has(ownerOf(target)) &&
    !deletedOwners.has(ownerOf(target)) &&
    selected &&
    context?.directory === directory &&
    !context.sessionID
  ) {
    const promotion = { target }
    trackPromotion(promotion, ready)
    promotions.set(selected, promotion)
    void ready.catch(() => {
      if (deletedOwners.has(ownerOf(target)) && promotions.get(selected) === promotion) promotions.delete(selected)
    })
  }
  return ready
}

export function selectPanels(next: Context) {
  if (next.directory === context?.directory && next.sessionID === context.sessionID && pending) return pending
  const ticket = ++revision
  context = next
  setPanels(undefined)
  pending = enqueueOwners([next], async () => {
    await flush(next)
    await recoverTransfers(next)
    const result = await loadPanels(next)
    await retainTabs(next, result)
    for (const tab of result.state.tabs) if (tab.kind === "terminal") promoteTerminal(tab.id, result, next.sessionID)
    if (revision === ticket) setPanels(result)
    return result
  }).catch((error: unknown) => {
    if (revision === ticket) pending = undefined
    throw error
  })
  void pending.then(retryCancellations, () => {})
  return pending
}

export function openPanel(input: Omit<PanelTab, "id">, reuse = false) {
  const selected = pending
  const origin = context
  // Capture only promotions already requested; waiting for a later one would deadlock the queue.
  const promotion = selected && promotions.get(selected)
  const accepted = promotion?.ready
  // Opening a file waits for lookups; a tab the person picks meanwhile keeps the selection.
  const picked = panels()?.picks()
  const request = enqueueOwners(origin ? [origin, ...(promotion ? [promotion.target] : [])] : [], async () => {
    const source = await selected
    if (!source || !origin) return
    if (deletedOwners.has(ownerOf(promotion?.target ?? origin))) throw new Error(t("panel.persistError"))
    if (promotion)
      await (accepted ?? promotion.ready ?? trackPromotion(promotion, promote(origin.directory, promotion.target)))
    const target = promotion?.target ?? origin
    const result = promotion ? await loadPanels(target) : source
    if (input.kind === "file" && input.path) {
      const directory = input.fileDirectory ?? origin.directory
      await resolveDirectory(directory)
      if (!input.planSessionID) await resolveFile(directory, input.path)
      input = { ...input, fileDirectory: directory }
    }
    if (input.kind === "terminal") input = { ...input, ptyDirectory: input.ptyDirectory ?? origin.directory }
    if (deletedOwners.has(ownerOf(target))) throw new Error(t("panel.persistError"))
    const id = result.open(input, reuse, picked === undefined || result !== source || result.picks() === picked)
    if (!id) throw new Error(t("panel.persistError"))
    if (input.kind === "browser") await retainBrowser(target, id)
    if (input.kind === "file" && input.path) {
      const tab = result.state.tabs.find((tab) => tab.id === id)!
      await retainFile(tab.fileDirectory ?? target.directory, tab.path!, ownerOf(target))
    }
  })
  openings.add(request)
  void request.finally(() => openings.delete(request)).catch(() => {})
  return request
}

export function panelContext() {
  return context
}

export function releasePanels(target: Context, deleted = false) {
  // Reject new promotion associations immediately, while preserving transfers accepted before this deletion.
  if (deleted) deletingOwners.add(ownerOf(target))
  return enqueueOwners([target], async () => {
    if (deleted) {
      deletingOwners.delete(ownerOf(target))
      deletedOwners.add(ownerOf(target))
      await restoreTransfers()
      const transfer = target.sessionID && transfers.get(target.sessionID)
      if (transfer) {
        transfer.cancelled = true
        return complete(transfer)
      }
    }
    const state = await loadPanels(target)
    await flushDrafts()
    await releaseResources(target, state.state.tabs, deleted)
    await state.update({ visible: false })
    releaseReview(target.directory, target.sessionID, deleted)
    if (deleted && target.sessionID) releaseReviewDrafts(target.directory, target.sessionID)
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

async function releaseResources(target: Context, tabs: PanelTab[], deleted: boolean) {
  const failures: unknown[] = []
  for (const tab of tabs) {
    try {
      if (tab.kind === "terminal") await stopTerminal(tab)
      if (tab.kind === "browser" && bridge) {
        const closed = deleted ? await bridge.browserClose(tab.id) : await bridge.browserRelease(tab.id)
        if (!closed) throw new Error("MRK-7013")
      }
      if (tab.kind === "browser" && deleted) await releaseBrowserState(tab.id)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw failures[0]
}

export async function togglePanels() {
  const state = await pending
  if (state) await state.update({ visible: !state.state.visible })
}
