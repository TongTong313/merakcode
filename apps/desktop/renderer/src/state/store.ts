import { batch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import {
  watchConversation,
  type CatalogModel,
  type ConfigPatch,
  type ConfigValue,
  type Conversation,
  type EngineEvent,
  type SessionInfo,
} from "@merakcode/sdk"
import { fromConfig, setLocale } from "../i18n"
import { log, storage } from "../lib/bridge"
import { sameDir } from "../lib/route"
import { client, onConnection, startConnection, type EngineClient } from "./client"

export type Folder = { directory: string }
export type SessionSummary = {
  id: string
  directory: string
  parentID?: string
  title: string
  time: { created: number; updated: number }
  config: SessionInfo["config"]
}

type State = {
  connected: boolean
  folders: Folder[]
  config?: ConfigValue
  models: CatalogModel[]
  sessions: SessionInfo[]
  views: Record<string, Conversation>
  titles: Record<string, string>
  hidden: string[]
  updated: Record<string, number>
  /** Worktrees the engine made for the open folders; a conversation in one is listed under its folder */
  worktrees: { path: string; root: string }[]
}

export const [state, setState] = createStore<State>({
  connected: false,
  folders: [],
  models: [],
  sessions: [],
  views: {},
  titles: {},
  hidden: [],
  updated: {},
  worktrees: [],
})
const listeners = new Set<(directory: string, event: EngineEvent) => void>()
const watches = new Map<string, Promise<{ close(): Promise<void> }>>()
let generation = 0

export function listen(listener: (directory: string, event: EngineEvent) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function receive(event: EngineEvent) {
  const id = event.scope.session
  if (event.type === "session.created" && !state.sessions.some((info) => info.id === event.payload.id)) {
    setState("sessions", (items) => [
      ...items,
      { id: event.payload.id, createdAt: event.time, config: event.payload.config },
    ])
    if (
      !event.payload.config.member &&
      state.folders.some((folder) => sameDir(folder.directory, event.payload.config.workdir))
    )
      void messages(event.payload.id).catch(failed)
    else void loadWorktrees().catch(failed)
  }
  if (id && event.seq) setState("updated", id, Date.parse(event.time))
  const directory =
    event.type === "file.changed" || event.type === "repo.changed"
      ? event.payload.directory
      : id
        ? (session(id)?.directory ?? "")
        : ""
  for (const listener of listeners) {
    try {
      listener(directory, event)
    } catch (error) {
      failed(error)
    }
  }
}

function failed(error: unknown) {
  log("error", "engine state request failed", {
    code: error instanceof Error ? error.message.match(/MRK-\d{4}/)?.[0] : undefined,
  })
}

function closeWatches() {
  for (const pending of watches.values()) void pending.then((watch) => watch.close()).catch(failed)
  watches.clear()
}

export function connect() {
  const stopListening = onConnection((connection) => {
    generation++
    closeWatches()
    setState("connected", !!connection)
    if (!connection) return
    const epoch = generation
    void connection.events
      .subscribe({}, (event) => {
        if (epoch === generation) receive(event)
      })
      .then(async () => {
        if (epoch !== generation) return
        await refresh(connection)
      })
      .catch(failed)
  })
  const stopConnection = startConnection()
  return () => {
    generation++
    stopListening()
    stopConnection()
    closeWatches()
  }
}

async function loadConfig() {
  const config = await (await client()).config.get()
  setState("config", reconcile(config))
  const language = fromConfig(config.locale)
  if (language) setLocale(language)
  return config
}

export async function updateConfig(patch: ConfigPatch) {
  const config = await (await client()).config.set(patch)
  setState("config", reconcile(config))
  const language = fromConfig(config.locale)
  if (language) setLocale(language)
  await loadProviders()
  return config
}

export async function loadProviders() {
  const connection = await client()
  const [config, models] = await Promise.all([connection.config.get(), connection.model.list()])
  batch(() => {
    setState("config", reconcile(config))
    setState("models", reconcile(models ?? []))
  })
}

/** Reads the worktrees of every open folder, so conversations that run in one are listed with their project. */
async function loadWorktrees() {
  const connection = await client()
  const lists = await Promise.all(
    state.folders.map((folder) => connection.worktree.list({ directory: folder.directory }).catch(() => [])),
  )
  const known = lists.flatMap((list) => list ?? [])
  setState("worktrees", reconcile(known.map((tree) => ({ path: tree.path, root: tree.root }))))
  await Promise.all(
    state.sessions
      .filter((info) => known.some((tree) => sameDir(tree.path, info.config.workdir)))
      .map((info) => messages(info.id)),
  )
}

async function refresh(connection?: EngineClient) {
  const active = connection ?? (await client())
  const list = await active.session.list()
  setState("sessions", reconcile(list ?? []))
  await loadWorktrees()
  await loadProviders()
  // The threads of group members are read when a group page or a task shows them; watching all of them here would
  // make the start wait for every running agent
  const results = await Promise.allSettled(
    state.sessions
      .filter(
        (info) => !info.config.member && state.folders.some((folder) => sameDir(folder.directory, info.config.workdir)),
      )
      .map((info) => messages(info.id)),
  )
  for (const result of results) if (result.status === "rejected") failed(result.reason)
}

export async function bootstrap() {
  const [folders, titles, hidden] = await Promise.all([
    storage.get<string[]>("folders", []),
    storage.get<Record<string, string>>("session-titles", {}),
    storage.get<string[]>("hidden-sessions", []),
  ])
  batch(() => {
    setState(
      "folders",
      folders.map((directory) => ({ directory })),
    )
    setState("titles", titles)
    setState("hidden", hidden)
  })
  await Promise.all([loadConfig(), refresh()])
}

export const connected = () =>
  state.models.some((model) => {
    const provider = state.config?.providers?.[model.provider]
    return provider && !provider.disabled && (provider.hasKey || !!provider.baseURL)
  })
const folderOf = (directory: string) => state.folders.find((folder) => sameDir(folder.directory, directory))

export async function openFolder(directory: string) {
  if (!folderOf(directory)) {
    setState("folders", (folders) => [{ directory }, ...folders])
    await storage.set(
      "folders",
      state.folders.map((folder) => folder.directory),
    )
  }
  await refresh()
}

export async function closeFolder(directory: string) {
  const connection = await client()
  for (const terminal of (await connection.terminal.list({ directory })) ?? [])
    await connection.terminal.remove({ id: terminal.id })
  setState("folders", (folders) => folders.filter((folder) => !sameDir(folder.directory, directory)))
  void storage.set(
    "folders",
    state.folders.map((folder) => folder.directory),
  )
}

export function session(id: string): SessionSummary | undefined {
  const info = state.sessions.find((item) => item.id === id)
  const view = state.views[id]
  if (!info && !view) return
  const config = view?.state.config ?? info!.config
  const first = view?.state.messages?.find((message) => message.role === "user")
  const title =
    first?.parts
      ?.filter((part) => part.text)
      .at(-1)
      ?.text?.slice(0, 80) ?? ""
  const created = info ? Date.parse(info.createdAt) : 0
  return {
    id,
    directory: config.workdir,
    parentID: config.parent,
    title: state.titles[id] ?? title,
    time: { created, updated: state.updated[id] ?? created },
    config,
  }
}

/** Every conversation the person started, newest change first; the sidebar and the home page list these. */
export function conversations() {
  return state.sessions
    .filter((info) => !info.config.parent && !info.config.member && !state.hidden.includes(info.id))
    .map((info) => session(info.id)!)
    .toSorted((a, b) => b.time.updated - a.time.updated)
}

/** The conversations of a folder, also those that run in a worktree of it. */
export function sessionsOf(folder: Folder) {
  return conversations().filter(
    (item) =>
      sameDir(item.directory, folder.directory) ||
      state.worktrees.some((tree) => sameDir(tree.root, folder.directory) && sameDir(tree.path, item.directory)),
  )
}

export async function renameSession(id: string, title: string) {
  setState("titles", id, title)
  await storage.set("session-titles", state.titles)
}

export async function hideSession(id: string) {
  if (!state.hidden.includes(id)) setState("hidden", (ids) => [...ids, id])
  await storage.set("hidden-sessions", state.hidden)
}

/**
 * Removes a conversation for good: the engine deletes its history, the window forgets it. It is hidden first, while
 * its folder is still known, so the panels, terminals and drafts of the conversation are released with it.
 */
export async function deleteSession(id: string) {
  await (await client()).session.delete({ session: id })
  await hideSession(id)
  const watch = watches.get(id)
  watches.delete(id)
  void watch?.then((open) => open.close()).catch(failed)
  batch(() => {
    setState("sessions", (items) => items.filter((info) => info.id !== id))
    setState("views", id, undefined!)
  })
}

export async function ensureSession(id: string) {
  await messages(id)
  return session(id)
}

async function messages(id: string) {
  const existing = watches.get(id)
  if (existing) return existing
  const epoch = generation
  const pending = client().then((connection) =>
    watchConversation(
      connection,
      id,
      (view) => {
        if (generation === epoch) setState("views", id, reconcile(view))
      },
      (error) => {
        failed(error)
        void connection.close()
      },
    ),
  )
  watches.set(id, pending)
  try {
    return await pending
  } catch (error) {
    if (watches.get(id) === pending) watches.delete(id)
    throw error
  }
}

export const busy = (id: string) => state.views[id]?.state.status === "running"
export function pending(id: string) {
  const views = Object.values(state.views).filter((view) => view.state.id === id || view.state.config.parent === id)
  return {
    permissions: views.flatMap((view) => Object.values(view.permissions)),
    questions: views.flatMap((view) => Object.values(view.questions)),
  }
}
export function statusOf(id: string) {
  const requests = pending(id)
  if (requests.permissions.length) return "approval"
  if (requests.questions.length) return "question"
  return busy(id) ? "running" : "idle"
}
