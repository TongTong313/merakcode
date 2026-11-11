import { createStore } from "solid-js/store"
import z from "zod"
import { registerDirty } from "../../state/git"
import { fileAddress, sameFileDirectory } from "../code/identity"
import { ownReviewProtection } from "../review/protection"

const tabSchema = z
  .object({
    id: z.string(),
    navigation: z.number().optional(),
    ordinal: z.number().optional(),
    kind: z.enum(["file", "review", "plan", "git", "terminal", "browser"]),
    planSessionID: z.string().optional(),
    path: z.string().optional(),
    fileDirectory: z.string().optional(),
    url: z.string().optional(),
    ptyID: z.string().optional(),
    ptyDirectory: z.string().optional(),
    title: z.string().optional(),
    view: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((tab) => tab.kind !== "file" || !!tab.path)
export type PanelTab = z.infer<typeof tabSchema>
type TabInput = Omit<PanelTab, "id">
const kinds = ["file", "review", "plan", "git", "terminal", "browser"] as const
const singleton = (kind: PanelTab["kind"]) => kind === "review" || kind === "git" || kind === "plan"

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const messages = (view: Record<string, unknown>) =>
  [view.commit, ...(Array.isArray(view.commitAlternatives) ? view.commitAlternatives : [])].filter(
    (value): value is string => typeof value === "string" && !!value.trim(),
  )

function mergeView(keep: PanelTab, other: PanelTab) {
  const primary = keep.view ?? {}
  const secondary = other.view ?? {}
  const view = { ...secondary, ...primary }
  if (keep.kind === "git") {
    const values = [...new Set([...messages(primary), ...messages(secondary)])]
    view.commit = typeof primary.commit === "string" && primary.commit.trim() ? primary.commit : (values.shift() ?? "")
    view.commitAlternatives = values.filter((value) => value !== view.commit)
  }
  if (keep.kind === "review") {
    const comments = { ...record(primary.comments) }
    const remapped = new Map<number, number>()
    let next =
      Math.max(
        0,
        ...Object.values(comments).flatMap((list) =>
          Array.isArray(list) ? list.map((item) => Number(record(item).id) || 0) : [],
        ),
      ) + 1
    for (const [key, value] of Object.entries(record(secondary.comments))) {
      const list = Array.isArray(comments[key]) ? ([...comments[key]] as Record<string, unknown>[]) : []
      for (const item of Array.isArray(value) ? value : []) {
        const source = record(item)
        const signature = (item: Record<string, unknown>) => JSON.stringify({ ...item, id: undefined })
        const known = list.find((item) => signature(item) === signature(source))
        const id = known ? Number(known.id) : next++
        remapped.set(Number(source.id), id)
        if (!known) list.push({ ...source, id })
      }
      comments[key] = list
    }
    const drafts = { ...record(primary.drafts) }
    for (const [original, value] of Object.entries(record(secondary.drafts))) {
      const draft = record(value)
      const sourceTarget = record(draft.target)
      const target = {
        ...sourceTarget,
        relocating: undefined,
        ...(typeof sourceTarget.editing === "number"
          ? { editing: remapped.get(sourceTarget.editing) ?? sourceTarget.editing }
          : {}),
      }
      const equivalent = Object.values(drafts).some((other) => {
        const previous = record(other)
        return (
          previous.text === draft.text &&
          JSON.stringify({ ...record(previous.target), key: undefined, relocating: undefined }) ===
            JSON.stringify({ ...target, key: undefined, relocating: undefined })
        )
      })
      if (equivalent) continue
      let key = original
      for (let index = 0; Object.hasOwn(drafts, key); index++) key = `${original}:restored:${other.id}:${index}`
      drafts[key] = {
        ...draft,
        target: {
          ...target,
          key,
        },
      }
    }
    view.comments = comments
    view.commenting = primary.commenting
    view.selecting = primary.selecting
    view.drafts = drafts
    view.files = { ...record(secondary.files), ...record(primary.files) }
    view.seen = { ...record(secondary.seen), ...record(primary.seen) }
  }
  return view
}

function coalesce(tabs: PanelTab[], selected?: string) {
  const survivors = new Map<string, PanelTab>()
  const removed = new Map<string, string>()
  for (const tab of tabs) {
    if (!singleton(tab.kind) && tab.kind !== "file") continue
    const key =
      tab.kind === "file"
        ? ([...survivors].find(([, known]) => sameFile(known, tab))?.[0] ?? `file:${tab.id}`)
        : tab.kind
    const previous = survivors.get(key)
    if (!previous || tab.id === selected) survivors.set(key, { ...tab, ...(singleton(tab.kind) ? { ordinal: 1 } : {}) })
  }
  for (const tab of tabs) {
    const keep = [...survivors.values()].find((item) =>
      tab.kind === "file" ? sameFile(item, tab) : item.kind === tab.kind,
    )
    if (!keep || keep.id === tab.id) continue
    keep.view = mergeView(keep, tab)
    removed.set(tab.id, keep.id)
  }
  return {
    tabs: tabs
      .filter((tab) => !removed.has(tab.id))
      .map((tab) => [...survivors.values()].find((item) => item.id === tab.id) ?? tab),
    selected: selected && (removed.get(selected) ?? selected),
  }
}

const sameFile = (a: TabInput, b: TabInput) =>
  a.kind === "file" &&
  b.kind === "file" &&
  !!a.path &&
  !!b.path &&
  a.planSessionID === b.planSessionID &&
  a.path === b.path &&
  (a.fileDirectory === b.fileDirectory ||
    (!!a.fileDirectory && !!b.fileDirectory && sameFileDirectory(a.fileDirectory, b.fileDirectory)))
type Persistence = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> }
const schema = z.object({
  version: z.literal(1),
  directory: z.string().optional(),
  tabs: z.array(z.unknown()),
  selected: z.string().optional(),
  visible: z.boolean().default(false),
  width: z.number().min(180).max(4000).default(560),
  expanded: z.array(z.string()).default([]),
})

/** Validate each saved descriptor before either identity lookup or controller restoration. */
export function parseLayout(raw: string | null) {
  try {
    const saved = schema.parse(JSON.parse(raw ?? "null"))
    const tabs = saved.tabs.flatMap((value) => {
      const tab = tabSchema.safeParse(value)
      return tab.success ? [tab.data] : []
    })
    return { ...saved, tabs }
  } catch {
    return undefined
  }
}

export async function createPanels(owner: string, persistence: Persistence, directory?: string) {
  const normalize = <T extends TabInput>(tab: T): T => {
    if (tab.kind !== "file" || !tab.path) return tab
    const address = fileAddress(tab.fileDirectory ?? directory ?? "", tab.path, tab.planSessionID)
    return { ...tab, path: address.path, ...(address.directory ? { fileDirectory: address.directory } : {}) }
  }
  const raw = await persistence.get(owner)
  const saved = parseLayout(raw)
  const parsedTabs = saved?.tabs ?? []
  const merged = coalesce(parsedTabs.map(normalize), saved?.selected)
  const tabs = merged.tabs
  if (JSON.stringify(tabs) !== JSON.stringify(parsedTabs))
    await persistence.set(owner, JSON.stringify({ ...saved, version: 1, directory, tabs, selected: merged.selected }))
  const [state, setState] = createStore({
    tabs,
    selected: tabs.some((tab) => tab.id === merged.selected) ? merged.selected : tabs[0]?.id,
    visible: saved?.visible ?? false,
    width: saved?.width ?? 560,
    expanded: saved?.expanded ?? [],
    chooser: undefined as "new" | "files" | undefined,
    error: undefined as string | undefined,
    transferring: false,
  })
  let writing = Promise.resolve()
  let retired = false
  let latest = JSON.stringify({ version: 1, directory, ...state })
  const registered = new Set<string>()
  ownReviewProtection(owner)
  const syncReviews = (clear = false) => {
    if (!directory) return
    const remaining = new Set<string>()
    for (const tab of state.tabs) {
      if (tab.kind !== "review") continue
      const key = `review-tab:${owner}:${tab.id}`
      remaining.add(key)
      const view = tab.view
      const comments = Object.values((view?.comments ?? {}) as Record<string, unknown>).some(
        (value) => Array.isArray(value) && value.length > 0,
      )
      const drafts = Object.values((view?.drafts ?? {}) as Record<string, { text?: unknown } | null>).some(
        (value) => typeof value?.text === "string" && !!value.text.trim(),
      )
      if (comments || drafts || clear) registerDirty(directory, key, comments || drafts ? 1 : 0)
    }
    for (const key of registered)
      if (!remaining.has(key)) {
        if (clear) registerDirty(directory, key, 0)
        else remaining.add(key)
      }
    registered.clear()
    for (const key of remaining) registered.add(key)
  }
  syncReviews(true)
  let inFlight = false
  const write = (value: string) => {
    latest = value
    if (inFlight) return writing
    inFlight = true
    writing = Promise.resolve().then(async () => {
      try {
        for (;;) {
          const payload = latest
          await persistence.set(owner, payload)
          if (latest !== payload) continue
          syncReviews(true)
          inFlight = false
          setState("error", undefined)
          return
        }
      } catch (error) {
        inFlight = false
        setState("error", String(error))
        throw error
      }
    })
    void writing.catch(() => {})
    return writing
  }
  const save = () => {
    syncReviews()
    return retired ? writing : write(JSON.stringify({ version: 1, directory, ...state }))
  }
  let closing = 0
  let idle = Promise.resolve()
  let finish = () => {}
  return {
    state,
    available: () => kinds.filter((kind) => !singleton(kind) || !state.tabs.some((tab) => tab.kind === kind)),
    transfer(value: boolean) {
      setState("transferring", value)
    },
    beginClose() {
      if (!closing) {
        const wait = Promise.withResolvers<void>()
        idle = wait.promise
        finish = wait.resolve
      }
      closing++
      return () => {
        if (--closing === 0) finish()
      }
    },
    idle: () => idle,
    update(update: Partial<Omit<typeof state, "tabs">>) {
      setState(update)
      return save()
    },
    patch(id: string, update: Partial<TabInput>) {
      if (!state.tabs.some((tab) => tab.id === id)) return Promise.resolve()
      setState("tabs", (tab) => tab.id === id, update)
      return save()
    },
    view(id: string) {
      return state.tabs.find((tab) => tab.id === id)?.view ?? {}
    },
    patchView(id: string, value: Record<string, unknown>) {
      if (!state.tabs.some((tab) => tab.id === id)) return Promise.resolve()
      // Merge from the latest view so concurrent writers cannot drop each other's keys.
      setState(
        "tabs",
        (item) => item.id === id,
        "view",
        (view) => ({ ...(view ?? {}), ...value }),
      )
      return save()
    },
    activate(id: string) {
      if (!state.tabs.some((tab) => tab.id === id)) return
      setState({ selected: id, chooser: undefined, visible: true })
      void save()
    },
    open(input: TabInput, reuse = false) {
      if (retired || state.transferring) return ""
      input = normalize(input)
      const known = [...state.tabs]
        .reverse()
        .find(
          (tab) =>
            tab.kind === input.kind &&
            (input.kind === "file"
              ? sameFile(tab, input)
              : singleton(input.kind) || (reuse && (input.kind !== "browser" || tab.url === input.url))),
        )
      if (known) {
        if (input.view)
          setState(
            "tabs",
            (tab) => tab.id === known.id,
            "view",
            (view) => ({ ...(view ?? {}), ...input.view }),
          )
        setState("tabs", (tab) => tab.id === known.id, "navigation", (known.navigation ?? 0) + 1)
        setState({ selected: known.id, chooser: undefined, visible: true })
        void save()
        return known.id
      }
      const id = crypto.randomUUID()
      setState("tabs", (tabs) => [
        ...tabs,
        {
          ...input,
          id,
          ordinal: Math.max(0, ...tabs.filter((tab) => tab.kind === input.kind).map((tab) => tab.ordinal ?? 1)) + 1,
        },
      ])
      setState({ selected: id, chooser: undefined, visible: true })
      void save()
      return id
    },
    remove(id: string) {
      const index = state.tabs.findIndex((tab) => tab.id === id)
      if (index < 0) return
      setState("tabs", (tabs) => tabs.filter((tab) => tab.id !== id))
      if (state.selected === id) setState("selected", (state.tabs[index] ?? state.tabs[index - 1])?.id)
      return save()
    },
    adopt(value: unknown) {
      const parsed = schema.parse(value)
      const incoming = parsed.tabs.flatMap((value) => {
        const tab = tabSchema.safeParse(value)
        return tab.success ? [normalize(tab.data)] : []
      })
      const empty = !state.tabs.length
      const merged = [...state.tabs]
      for (const tab of incoming) {
        if (merged.some((known) => known.id === tab.id || sameFile(tab, known))) continue
        merged.push({
          ...tab,
          ordinal:
            Math.max(0, ...merged.filter((known) => known.kind === tab.kind).map((known) => known.ordinal ?? 1)) + 1,
        })
      }
      const result = coalesce(merged, empty ? parsed.selected : state.selected)
      setState("tabs", result.tabs)
      if (empty)
        setState({
          selected: result.tabs.some((tab) => tab.id === result.selected) ? result.selected : result.tabs[0]?.id,
          visible: parsed.visible,
          width: parsed.width,
          expanded: parsed.expanded,
        })
      return save()
    },
    flush: () => (state.error ? write(latest) : writing),
    async retire() {
      retired = true
      setState({ tabs: [], selected: undefined, visible: false })
      syncReviews()
      await write(JSON.stringify({ version: 1, directory, tabs: [] }))
    },
  }
}

export type Panels = Awaited<ReturnType<typeof createPanels>>
