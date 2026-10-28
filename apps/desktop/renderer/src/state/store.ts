/**
 * Global state: projects (the sidebar folders), messages and status of every session (engine events reduced by
 * sdk/store), config and providers.
 *
 * - Sessions are bucketed by project: a git project's worktrees and main checkout are one project, and each session's
 *   directory is its own checkout
 * - Directories outside a git repository all belong to the engine's global project, so session lists filter by
 *   directory
 * - Pending request snapshots replace only their own directory; event replay preserves newer requests
 */
import { batch } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type {
  Config,
  ConfigWarning,
  Event,
  GlobalEvent,
  Message,
  Part,
  PermissionMode,
  Project,
  ProviderListResponses,
  Session,
} from "@merakcode/sdk/client"
import { activity, applyEvent, createSessionsState, rootOf, search, type SessionsState } from "@merakcode/sdk/store"
import { log, storage } from "../lib/bridge"
import { sameDir } from "../lib/route"
import { fromConfig, setLocale, t } from "../i18n"
import { toast } from "../ui/toast"
import { providerChanged, type SeenFailures } from "./catalog-refresh"
import { call, client } from "./client"
import { checkoutOf, gitDirectory, identityOf, onCheckoutChange, updateCheckout } from "./git"
import { MessageSnapshot } from "./message-snapshot"

type Providers = ProviderListResponses[200]

export type Folder = {
  /** Directory the user opened */
  directory: string
  project?: Project
  /** The session list has more pages to load */
  more?: boolean
}

type State = {
  /** The event stream is connected */
  connected: boolean
  config?: Config
  providers?: Providers
  folders: Folder[]
  sessions: SessionsState
  /** Directory → current branch */
  branch: Record<string, string | undefined>
  head: Record<string, string | null | undefined>
  /** Directory → the repository's default branch (vcs.get) */
  defaultBranch: Record<string, string | undefined>
  /** Directory → push remote, ahead/behind, and staged / unstaged / untracked file counts (vcs.get) */
  remote: Record<
    string,
    | {
        name?: string
        ahead?: number
        behind?: number
        staged?: number
        unstaged?: number
        untracked?: number
      }
    | undefined
  >
  /** Session id → messages loaded */
  loaded: Record<string, boolean>
  /** Default permission mode for new conversations */
  mode: PermissionMode
  /** Invalid config entries the engine skipped */
  warnings: ConfigWarning[]
}

export const [state, setState] = createStore<State>({
  connected: false,
  folders: [],
  sessions: createSessionsState(),
  branch: {},
  head: {},
  defaultBranch: {},
  remote: {},
  loaded: {},
  mode: "ask",
  warnings: [],
})

const PAGE = 40

onCheckoutChange((directory, current) => {
  const directories = new Set([
    directory,
    ...Object.keys(state.branch).filter((key) => sameDir(gitDirectory(key), directory)),
  ])
  for (const key of directories) {
    setState("branch", key, current.branch ?? undefined)
    setState("head", key, current.head)
  }
  void refreshVcs(directory)
})

type Listener = (directory: string, event: Event) => void
const listeners = new Set<Listener>()
const pendingSnapshots = new Map<string, { events: Event[] }>()
const messageLoads = new Map<string, { snapshot: MessageSnapshot; promise: Promise<void> }>()
const pendingEvent = (event: Event) =>
  event.type === "permission.asked" ||
  event.type === "permission.replied" ||
  event.type === "question.asked" ||
  event.type === "question.replied" ||
  event.type === "question.rejected"

/** Subscribes to raw events (review, code, terminal and others pick the ones they need) */
export function listen(fn: Listener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function reduce(draft: SessionsState, event: Event) {
  applyEvent(draft, event)
}

let catalogFailures: SeenFailures = {}

function dispatch(directory: string, event: Event) {
  for (const load of messageLoads.values()) load.snapshot.observe(event)
  if (pendingEvent(event))
    for (const [dir, snapshot] of pendingSnapshots) {
      if (sameDir(directory, dir)) snapshot.events.push(event)
    }
  setState(
    "sessions",
    produce((draft) => reduce(draft, event)),
  )
  if (event.type === "vcs.branch.updated") setState("branch", directory, event.properties.branch)
  if (event.type === "vcs.head.updated")
    updateCheckout(
      directory,
      event.properties.checkout ? { ...event.properties, checkout: event.properties.checkout } : null,
      event.properties.branchChanged,
    )
  if (event.type === "provider.changed") {
    const decision = providerChanged(catalogFailures, event.properties)
    catalogFailures = decision.seen
    if (decision.reload) {
      const notice = decision.toast
      void loadProviders().then(() => {
        if (!notice) return
        const name = state.providers?.all.find((item) => item.id === notice.providerID)?.name ?? notice.providerID
        toast({
          kind: "error",
          title: t("model.catalog.failed", { provider: name, code: notice.code, message: notice.message }),
          error: event.type === "provider.changed" ? event.properties.error : undefined,
        })
      })
    }
  }
  if (event.type === "project.updated") {
    const project = event.properties
    setState("folders", (folder) => folder.project?.id === project.id && project.id !== "global", "project", project)
  }
  for (const fn of listeners) {
    try {
      fn(directory, event)
    } catch (error) {
      log("error", "event listener failed", { type: event.type, error: String(error) })
    }
  }
}

/**
 * Global event stream: events within 16ms are applied as one batch. The client reconnects on its own after a drop;
 * once reconnected (server.connected arrives again) state is fetched again to catch up on missed events.
 */
export function connect() {
  const abort = new AbortController()
  let queue: GlobalEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let connections = 0
  const flush = () => {
    timer = undefined
    const items = queue
    queue = []
    batch(() => {
      // Project broadcasts and transport heartbeats have no directory on the wire.
      for (const item of items) dispatch(item.directory ?? "global", item.payload)
    })
  }
  void (async () => {
    const result = await client().global.event({
      signal: abort.signal,
      sseDefaultRetryDelay: 1000,
      sseMaxRetryDelay: 5000,
      onSseError: (error) => {
        setState("connected", false)
        log("warn", "event stream error", { error: String(error) })
      },
    })
    for await (const item of result.stream) {
      if (item.payload.type === "server.connected") {
        setState("connected", true)
        if (connections++ > 0) void resync()
        continue
      }
      queue.push(item)
      timer ??= setTimeout(flush, 16)
    }
  })().catch((error: unknown) => {
    if (!abort.signal.aborted) log("error", "event stream stopped", { error: String(error) })
  })
  return () => abort.abort()
}

/**
 * After reconnecting, what the engine reports replaces what was known: it may have restarted, so a session that was
 * running is idle unless reported again, and open sessions reload their messages. setState merges objects, so the old
 * entries are replaced with reconcile rather than set to {}.
 */
async function resync() {
  const opened = [...new Set([...Object.keys(state.loaded).filter((id) => state.loaded[id]), ...messageLoads.keys()])]
  messageLoads.clear()
  setState("loaded", reconcile({}))
  setState("sessions", "session_status", reconcile({}))
  await Promise.all(state.folders.map((folder) => refresh(folder.directory).catch(() => {})))
  await Promise.all(opened.map((id) => messages(id).catch(() => {})))
}

/** Reads the global config; also called again after a config change (e.g. a provider was removed) */
export async function loadConfig() {
  const config = await call(client().global.config.get())
  setState("config", config)
  const locale = fromConfig(config.locale)
  if (locale) setLocale(locale)
  return config
}

export async function updateConfig(patch: Config, options?: { skipDispose?: boolean }) {
  const config = await call(
    client().global.config.update({
      config: patch,
      ...(options?.skipDispose ? { skipDispose: "true" as const } : {}),
    }),
  )
  setState("config", config)
  void loadWarnings()
  return config
}

/** Invalid config entries that were skipped; read after opening a project or changing config */
async function loadWarnings(directory = state.folders[0]?.directory) {
  setState("warnings", await call(client(directory).config.warnings()).catch(() => []))
}

export async function loadProviders(directory = state.folders[0]?.directory) {
  const providers = await call(client(directory).provider.list())
  setState("providers", providers)
  return providers
}

type GitInfo = {
  branch?: string
  head?: string | null
  checkout?: string | null
  default_branch?: string
  remote?: string
  ahead?: number
  behind?: number
  staged?: number
  unstaged?: number
  untracked?: number
}

/** Keeps the fields the review bar shows. Extra fields arrive with the generated client after a status change. */
function remembered(vcs: GitInfo | undefined) {
  if (!vcs) return undefined
  return {
    name: vcs.remote,
    ahead: vcs.ahead,
    behind: vcs.behind,
    staged: vcs.staged,
    unstaged: vcs.unstaged,
    untracked: vcs.untracked,
  }
}

/** Reloads a directory's git state after a commit, push, or when the review bar opens */
export async function refreshVcs(directory: string) {
  const before = checkoutOf(directory)
  const vcs = await call(client(directory).vcs.get()).catch(() => undefined)
  if (!vcs) return
  if (before !== checkoutOf(directory)) return
  if (vcs?.checkout)
    updateCheckout(directory, {
      branch: vcs.branch === "HEAD" ? null : vcs.branch || null,
      head: vcs.head ?? null,
      checkout: vcs.checkout,
    })
  else if (vcs?.checkout === null) updateCheckout(directory, null)
  setState("branch", directory, vcs?.branch || undefined)
  setState("head", directory, vcs?.head)
  setState("defaultBranch", directory, vcs?.default_branch)
  setState("remote", directory, remembered(vcs))
}

/** At least one model is usable */
export const connected = () => (state.providers?.connected.length ?? 0) > 0

const KEY = "folders"

/** Startup: reads the config and the sidebar projects */
export async function bootstrap() {
  const [directories] = await Promise.all([storage.get<string[]>(KEY, []), loadConfig()])
  setState(
    "folders",
    directories.map((directory) => ({ directory })),
  )
  await Promise.all([loadProviders(), ...directories.map((directory) => refresh(directory).catch(() => {}))])
}

export const folderOf = (directory: string) => state.folders.find((folder) => sameDir(folder.directory, directory))

/** Checkout identity resolves alternate directory spellings before reading the branch. */
export function branchOf(directory: string) {
  const current = identityOf(directory)
  if (current !== undefined) return current ? (current.branch ?? "HEAD") : undefined
  return state.branch[directory]
}

/** Opens a project: moves it to the top of the sidebar and loads its sessions */
export async function openFolder(directory: string) {
  const existing = folderOf(directory)
  if (!existing) {
    setState("folders", (list) => [{ directory }, ...list])
    void storage.set(
      KEY,
      state.folders.map((folder) => folder.directory),
    )
  }
  await refresh(existing?.directory ?? directory)
  if (!state.providers) await loadProviders(directory)
  await loadWarnings(directory)
}

export function closeFolder(directory: string) {
  setState("folders", (list) => list.filter((folder) => !sameDir(folder.directory, directory)))
  void storage.set(
    KEY,
    state.folders.map((folder) => folder.directory),
  )
}

/** Every directory of a project: the main directory and its worktrees (each one is an engine instance) */
function directories(folder: Folder) {
  const sandboxes = folder.project && folder.project.id !== "global" ? folder.project.sandboxes : []
  return [folder.directory, ...sandboxes.filter((dir) => !sameDir(dir, folder.directory))]
}

/**
 * Reloads a project: project info, session list, and per directory the session status, pending permissions and
 * questions, and branch
 */
async function refresh(directory: string, limit = PAGE) {
  const project = await call(client(directory).project.current())
  setState("folders", (folder) => sameDir(folder.directory, directory), "project", project)
  const folder = folderOf(directory)
  if (!folder) return
  const list = await call(
    client(directory).session.list({ roots: true, limit, ...(project.id === "global" ? { directory } : {}) }),
  )
  setState("folders", (item) => sameDir(item.directory, directory), "more", list.length >= limit)
  const instances = await Promise.all(
    directories(folder).map(async (dir) => {
      const c = client(dir)
      const checkout = checkoutOf(dir)
      for (const key of pendingSnapshots.keys()) if (sameDir(dir, key)) pendingSnapshots.delete(key)
      const snapshot = { events: [] as Event[] }
      pendingSnapshots.set(dir, snapshot)
      const [status, permissions, questions, vcs] = await Promise.all([
        call(c.session.status()).catch(() => ({})),
        call(c.permission.list()).catch(() => undefined),
        call(c.question.list()).catch(() => undefined),
        project.vcs === "git" ? call(c.vcs.get()).catch(() => undefined) : undefined,
      ])
      return { dir, status, permissions, questions, vcs, checkout, snapshot }
    }),
  )
  batch(() => {
    setState(
      "sessions",
      produce((draft) => {
        for (const info of list) reduce(draft, { type: "session.updated", properties: { info } } as Event)
        for (const item of instances) {
          if (pendingSnapshots.get(item.dir) !== item.snapshot) continue
          Object.assign(draft.session_status, item.status)
          const owned = (request: { sessionID: string; root?: string }) => {
            const owner =
              draft.session.find((info) => info.id === request.sessionID) ??
              draft.session.find((info) => info.id === request.root)
            return !!owner && sameDir(owner.directory, item.dir)
          }
          if (item.permissions)
            for (const [id, requests] of Object.entries(draft.permission)) {
              draft.permission[id] = requests.filter((request) => !owned(request))
            }
          if (item.questions)
            for (const [id, requests] of Object.entries(draft.question)) {
              draft.question[id] = requests.filter((request) => !owned(request))
            }
          for (const request of item.permissions ?? [])
            reduce(draft, { type: "permission.asked", properties: request } as Event)
          for (const request of item.questions ?? [])
            reduce(draft, { type: "question.asked", properties: request } as Event)
          for (const event of item.snapshot.events) reduce(draft, event)
          pendingSnapshots.delete(item.dir)
        }
      }),
    )
    for (const item of instances) {
      if (checkoutOf(item.dir) !== item.checkout) continue
      setState("branch", item.dir, item.vcs?.branch)
      setState("head", item.dir, item.vcs?.head)
      if (item.vcs?.checkout)
        updateCheckout(item.dir, {
          branch: item.vcs.branch === "HEAD" ? null : item.vcs.branch || null,
          head: item.vcs.head ?? null,
          checkout: item.vcs.checkout,
        })
      setState("defaultBranch", item.dir, item.vcs?.default_branch)
      setState("remote", item.dir, remembered(item.vcs))
    }
  })
}

export async function loadMore(directory: string) {
  const folder = folderOf(directory)
  if (!folder) return
  const shown = sessionsOf(folder).length
  await refresh(directory, shown + PAGE)
}

/** A project's conversations (root sessions) in the sidebar, most recently updated first */
export function sessionsOf(folder: Folder) {
  const project = folder.project
  if (!project) return []
  return state.sessions.session
    .filter(
      (session) =>
        !session.parentID &&
        session.projectID === project.id &&
        (project.id !== "global" || sameDir(session.directory, folder.directory)),
    )
    .toSorted((a, b) => b.time.updated - a.time.updated)
}

export function session(id: string): Session | undefined {
  const found = search(state.sessions.session, id, (item) => item.id)
  return found.found ? state.sessions.session[found.index] : undefined
}

/** Fetches the session from the engine when it is not in the list (child sessions, old sessions) */
export async function ensureSession(id: string, directory: string) {
  const existing = session(id)
  if (existing) return existing
  const info = await call(client(directory).session.get({ sessionID: id }))
  setState(
    "sessions",
    produce((draft) => reduce(draft, { type: "session.updated", properties: { info } } as Event)),
  )
  return info
}

export async function messages(id: string) {
  if (state.loaded[id]) return
  const pending = messageLoads.get(id)
  if (pending) return pending.promise
  const info = session(id)
  if (!info) return
  const snapshot = new MessageSnapshot(id)
  const promise = (async () => {
    const list = await call(client(info.directory).session.messages({ sessionID: info.id, limit: 400 }))
    if (messageLoads.get(id)?.snapshot !== snapshot) return
    batch(() => {
      let loaded = false
      setState(
        "sessions",
        produce((draft) => {
          loaded = snapshot.apply(draft, list)
        }),
      )
      if (loaded) setState("loaded", id, true)
    })
  })().finally(() => {
    if (messageLoads.get(id)?.snapshot === snapshot) messageLoads.delete(id)
  })
  messageLoads.set(id, { snapshot, promise })
  return promise
}

/** Messages hidden by a revert; they can still be restored until the next message makes the engine delete them */
function hidden(id: string) {
  const stack = session(id)?.undoRedo?.stack ?? []
  return new Set(stack.flatMap((entry) => entry.hiddenMessages))
}

export const messagesOf = (id: string): Message[] => {
  const list = state.sessions.message[id] ?? []
  const skip = hidden(id)
  return skip.size ? list.filter((message) => !skip.has(message.id)) : list
}

/** Reloads messages, e.g. when restoring reverted ones: a conversation opened during the revert never had them */
export async function reload(id: string) {
  setState("loaded", id, false)
  await messages(id)
}
export const partsOf = (id: string): Part[] => state.sessions.part[id] ?? []
export const statusOf = (id: string) => activity(state.sessions, id)
export const busy = (id: string) => (state.sessions.session_status[id]?.type ?? "idle") !== "idle"

/** Pending permissions and questions in this conversation, including its child sessions */
export function pending(id: string) {
  const ours = (request: { sessionID: string; root?: string }) =>
    (request.root ?? rootOf(state.sessions, request.sessionID)) === id
  return {
    permissions: Object.values(state.sessions.permission).flatMap((list) => list.filter(ours)),
    questions: Object.values(state.sessions.question).flatMap((list) => list.filter(ours)),
  }
}
