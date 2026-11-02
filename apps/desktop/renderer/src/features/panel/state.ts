import { createStore } from "solid-js/store"
import z from "zod"
import { sameDir } from "../../lib/route"
import { registerDirty } from "../../state/git"

const tabSchema = z
  .object({
    id: z.string(),
    navigation: z.number().optional(),
    ordinal: z.number().optional(),
    kind: z.enum(["file", "review", "git", "terminal", "browser"]),
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

const sameFile = (a: TabInput, b: TabInput) =>
  a.kind === "file" &&
  b.kind === "file" &&
  !!a.path &&
  !!b.path &&
  sameDir(a.path, b.path) &&
  (a.fileDirectory === b.fileDirectory ||
    (!!a.fileDirectory && !!b.fileDirectory && sameDir(a.fileDirectory, b.fileDirectory)))
type Persistence = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> }
const schema = z.object({
  version: z.literal(1),
  tabs: z.array(z.unknown()),
  selected: z.string().optional(),
  visible: z.boolean().default(false),
  width: z.number().min(180).max(4000).default(560),
  tree: z.boolean().default(true),
  expanded: z.array(z.string()).default([]),
})

export async function createPanels(owner: string, persistence: Persistence, directory?: string) {
  const raw = await persistence.get(owner)
  const saved = (() => {
    try {
      return schema.parse(JSON.parse(raw ?? "null"))
    } catch {
      return undefined
    }
  })()
  const tabs = (saved?.tabs ?? []).flatMap((value) => {
    const tab = tabSchema.safeParse(value)
    return tab.success ? [tab.data] : []
  })
  const [state, setState] = createStore({
    tabs,
    selected: tabs.some((tab) => tab.id === saved?.selected) ? saved?.selected : tabs[0]?.id,
    visible: saved?.visible ?? false,
    width: saved?.width ?? 560,
    tree: saved?.tree ?? true,
    expanded: saved?.expanded ?? [],
    chooser: undefined as "new" | "files" | undefined,
    error: undefined as string | undefined,
    transferring: false,
  })
  let writing = Promise.resolve()
  let retired = false
  let latest = JSON.stringify({ version: 1, ...state })
  const registered = new Set<string>()
  const syncReviews = () => {
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
      registerDirty(directory, key, comments || drafts ? 1 : 0)
    }
    for (const key of registered) if (!remaining.has(key)) registerDirty(directory, key, 0)
    registered.clear()
    for (const key of remaining) registered.add(key)
  }
  syncReviews()
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
    return retired ? writing : write(JSON.stringify({ version: 1, ...state }))
  }
  let closing = 0
  let idle = Promise.resolve()
  let finish = () => {}
  return {
    state,
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
      const tab = state.tabs.find((tab) => tab.id === id)
      if (!tab) return Promise.resolve()
      setState("tabs", (item) => item.id === id, "view", { ...tab.view, ...value })
      return save()
    },
    activate(id: string) {
      if (!state.tabs.some((tab) => tab.id === id)) return
      setState({ selected: id, chooser: undefined, visible: true })
      void save()
    },
    open(input: TabInput, reuse = false) {
      if (retired || state.transferring) return ""
      if (input.kind === "file") input = { ...input, path: input.path?.replace(/\\/g, "/").replace(/^\.\//, "") }
      const known = [...state.tabs]
        .reverse()
        .find(
          (tab) =>
            tab.kind === input.kind &&
            (input.kind === "file"
              ? sameFile(tab, input)
              : reuse &&
                (input.kind === "review"
                  ? (tab.view?.scope ?? "turn") === (input.view?.scope ?? "turn") &&
                    tab.view?.messageID === input.view?.messageID
                  : input.kind === "browser"
                    ? tab.url === input.url
                    : true)),
        )
      if (known) {
        if (input.view) setState("tabs", (tab) => tab.id === known.id, "view", { ...known.view, ...input.view })
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
        return tab.success ? [tab.data] : []
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
      setState("tabs", merged)
      if (empty)
        setState({
          selected: merged.some((tab) => tab.id === parsed.selected) ? parsed.selected : merged[0]?.id,
          visible: parsed.visible,
          width: parsed.width,
          tree: parsed.tree,
          expanded: parsed.expanded,
        })
      return save()
    },
    flush: () => (state.error ? write(latest) : writing),
    async retire() {
      retired = true
      setState({ tabs: [], selected: undefined, visible: false })
      syncReviews()
      await write(JSON.stringify({ version: 1, tabs: [] }))
    },
  }
}

export type Panels = Awaited<ReturnType<typeof createPanels>>
