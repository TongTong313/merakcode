/**
 * Review data and actions, shared by the panel and the maximized view.
 *
 * Scopes: this turn / whole conversation (the agent's changes), unstaged / staged / branch (git). The engine lists the
 * files with counts and a version each (review.get) and returns one file's hunks on request (review.file). Accept /
 * reject go by hunk id (review.decide) and return the new list. A stale version or hunk id returns 409, which shows a
 * notice and refetches the list. Comments live only in the UI and are sent to the agent together.
 *
 * Lists are cached per review and file details per version (see cache.ts): switching back to a scope shows it at
 * once while it refreshes, and a refresh only refetches the files that changed. Events only mark lists stale; the
 * review on screen refreshes itself, and fetches details in the background while idle.
 */
import type { ReviewFile, ReviewFileDetail, ReviewHunk, ReviewResult, ReviewScope } from "@merakcode/sdk/client"
import type { ThemedToken } from "shiki/core"
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
  type Accessor,
  type Setter,
} from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { t } from "../../i18n"
import { storage } from "../../lib/bridge"
import { sameDir } from "../../lib/route"
import { tokenize } from "../../lib/tokens"
import { call, client } from "../../state/client"
import { busy, listen, messagesOf, refreshVcs } from "../../state/store"
import { showTab } from "../../state/ui"
import { toast } from "../../ui/toast"
import { autoExpand, detailKey, detailSize, keyOf, PREFETCH, prefetchQueue, type ReviewKey } from "./cache"

export type Comment = { id: number; file: string; line: number; text: string; excerpt: string }

type Review = {
  scope: ReviewScope
  /** For the turn scope: which turn (user message id); defaults to the last one */
  messageID?: string
  base?: string
  /** File to scroll to */
  focus?: string
  /** Hunk being commented on */
  commenting?: string
  comments: Record<string, Comment[]>
  style: "unified" | "split"
  /** Most recent decision, shown in the status bar and undoable */
  last?: { decision: "accept" | "reject"; count: number }
}

export const [review, setReview] = createStore<Review>({ scope: "turn", comments: {}, style: "split" })

let next = 1

/** Opens the review, optionally at a scope, a turn, or a file */
export function openReview(view: { scope?: ReviewScope; messageID?: string; file?: string } = {}) {
  setReview({
    ...(view.scope ? { scope: view.scope } : {}),
    messageID: view.messageID,
    focus: view.file,
    last: undefined,
  })
  showTab("review")
}

/** User message for the turn scope: the chosen one, or the last one */
function turnOf(sessionID: string) {
  return review.messageID ?? messagesOf(sessionID).findLast((message) => message.role === "user")?.id
}

const SCOPES: ReviewScope[] = ["turn", "session", "unstaged", "staged"]

/** The scopes in the segmented control (the branch scope is a separate dropdown); unavailable ones say why */
export const scopeOptions = (git: boolean, conversation: boolean) =>
  SCOPES.map((scope) => {
    const needs =
      scope === "turn" || scope === "session" ? (conversation ? undefined : "conversation") : git ? undefined : "git"
    return {
      value: scope,
      label: t(`review.scope.${scope}`),
      disabled: !!needs,
      hint:
        needs === "conversation" ? t("review.needsConversation") : needs === "git" ? t("review.needsGit") : undefined,
    }
  })

// Lists: one per review, refetched when stale

type List = { input: ReviewKey; result?: ReviewResult; loading: boolean; stale: boolean; error?: Error }
const [lists, setLists] = createStore<Record<string, List>>({})
const controllers = new Map<string, AbortController>()

const params = (input: ReviewKey) => ({
  scope: input.scope,
  ...(input.sessionID ? { sessionID: input.sessionID } : {}),
  ...(input.messageID ? { messageID: input.messageID } : {}),
  ...(input.base ? { base: input.base } : {}),
})

const empty = (input: ReviewKey): ReviewResult | undefined => {
  // No conversation yet: only the git scopes have data
  const conversation = input.scope === "turn" || input.scope === "session"
  if ((conversation && !input.sessionID) || (input.scope === "turn" && !input.messageID))
    return { scope: input.scope, actions: { accept: false, reject: false }, files: [] }
}

/** Fetches a list; a newer request for the same review cancels this one */
async function load(input: ReviewKey) {
  const key = keyOf(input)
  controllers.get(key)?.abort()
  const controller = new AbortController()
  controllers.set(key, controller)
  setLists(key, (current) => ({ ...current, input, loading: true, stale: false }))
  try {
    const result =
      empty(input) ?? (await call(client(input.directory).review.get(params(input), { signal: controller.signal })))
    if (!controller.signal.aborted) show(key, result)
  } catch (error) {
    if (!controller.signal.aborted) setLists(key, { loading: false, error: error as Error })
  } finally {
    if (controllers.get(key) === controller) controllers.delete(key)
  }
}

/** Puts a new list in place: files keep their identity by path, so open files and their state stay */
function show(key: string, result: ReviewResult) {
  batch(() => {
    setLists(key, "result", reconcile(result, { key: "file" }))
    setLists(key, { loading: false, error: undefined })
  })
  prune(key, result.files)
}

const statusTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Reloads git counts with the review, after a burst of file events has settled */
function refreshStatus(directory: string) {
  const pending = statusTimers.get(directory)
  if (pending) clearTimeout(pending)
  statusTimers.set(
    directory,
    setTimeout(() => {
      statusTimers.delete(directory)
      void refreshVcs(directory)
    }, 1000),
  )
}

/** Marks every list of a directory stale; the one on screen refreshes itself */
function stale(directory: string) {
  refreshStatus(directory)
  for (const [key, list] of Object.entries(lists))
    if (sameDir(list.input.directory, directory)) setLists(key, "stale", true)
}

let watching = false
function watch() {
  if (watching) return
  watching = true
  listen((directory, event) => {
    if (event.type === "review.updated" || event.type === "file.watcher.updated") return stale(directory)
    if (event.type !== "message.part.updated") return
    const part = event.properties.part
    if (
      part.type === "tool" &&
      part.state.status === "completed" &&
      ["edit", "write", "multi_edit", "bash"].includes(part.tool)
    )
      stale(directory)
  })
}

// Details: one per file version, each with its own signal so large hunks are not made reactive

type Tokens = { before?: ThemedToken[][]; after?: ThemedToken[][] }
type Detail = { detail?: ReviewFileDetail; error?: Error; tokens?: Tokens }
type Cell = { get: Accessor<Detail>; set: Setter<Detail> }

const details = new Map<string, Cell>()
const inflight = new Map<string, Promise<ReviewFileDetail | undefined>>()
const tokenizing = new Set<string>()
const DETAILS = 400

function cell(key: string) {
  const known = details.get(key)
  if (known) return known
  const [get, set] = createSignal<Detail>({})
  const created = { get, set }
  details.set(key, created)
  return created
}

/** Drops details of files that changed or left this list, and the oldest ones beyond the limit */
function prune(list: string, files: ReviewFile[]) {
  const keep = new Set(files.map((file) => detailKey(list, file)))
  for (const key of details.keys()) if (key.startsWith(`${list}\u0000`) && !keep.has(key)) details.delete(key)
  for (const key of details.keys()) {
    if (details.size <= DETAILS) break
    if (!keep.has(key)) details.delete(key)
  }
}

async function loadDetail(input: ReviewKey, file: ReviewFile) {
  const key = detailKey(keyOf(input), file)
  const target = cell(key)
  const known = target.get().detail
  if (known) return known
  const pending = inflight.get(key)
  if (pending) return pending
  target.set({})
  const request = call(
    client(input.directory).review.file({ ...params(input), file: file.file, version: file.version }),
  ).then(
    (detail) => {
      target.set({ detail })
      return detail
    },
    (error: Error & { status?: number }) => {
      if (error.status === 409) {
        target.set({})
        void load(input)
        return undefined
      }
      target.set({ error })
      return undefined
    },
  )
  inflight.set(key, request)
  void request.finally(() => inflight.delete(key))
  return request
}

async function loadTokens(input: ReviewKey, file: ReviewFile, lang: string | undefined) {
  const key = detailKey(keyOf(input), file)
  const target = details.get(key)
  const detail = target?.get().detail
  if (!lang || !detail || target!.get().tokens || tokenizing.has(key)) return
  tokenizing.add(key)
  const [before, after] = await Promise.all([
    detail.before !== undefined ? tokenize(detail.before, lang) : undefined,
    detail.after !== undefined ? tokenize(detail.after, lang) : undefined,
  ])
  tokenizing.delete(key)
  target!.set((current) => ({ ...current, tokens: { before, after } }))
}

let prefetching = 0

/** Fetches details in the background, in list order, within the prefetch budget; a newer list cancels it */
function prefetch(input: ReviewKey, files: ReviewFile[]) {
  const run = ++prefetching
  const list = keyOf(input)
  const queue = prefetchQueue(files, (file) => !!details.get(detailKey(list, file))?.get().detail)
  let bytes = 0
  const work = async () => {
    while (queue.length && run === prefetching && bytes < PREFETCH.bytes) {
      const detail = await loadDetail(input, queue.shift()!)
      if (detail) bytes += detailSize(detail)
    }
  }
  requestIdleCallback(
    () => {
      for (let i = 0; i < PREFETCH.concurrency; i++) void work()
    },
    { timeout: 2000 },
  )
}

// Open state of each file, by list and path, so it survives refreshes and scope switches

const [opened, setOpened] = createStore<Record<string, { open?: boolean; all?: boolean }>>({})
const openKey = (list: string, file: string) => `${list}\u0000${file}`

/** Waits this long after a list goes stale before refreshing it, so a burst of changes is one refresh */
const REFRESH = 1000

/**
 * Review data for one conversation. visible says whether the review is on screen: only then is the list fetched and
 * refreshed.
 */
export function useReview(
  sessionID: () => string | undefined,
  directory: () => string,
  visible: () => boolean = () => true,
) {
  watch()
  const input = createMemo(
    (): ReviewKey => {
      const scope = review.scope
      const id = sessionID()
      const messageID = scope === "turn" && id ? turnOf(id) : undefined
      return { directory: directory(), scope, sessionID: id, messageID, base: review.base }
    },
    undefined,
    { equals: (a, b) => keyOf(a) === keyOf(b) },
  )
  const key = () => keyOf(input())
  const list = () => lists[key()]
  const isStale = createMemo(() => !!list()?.stale)
  const loading = createMemo(() => !!list()?.loading)
  const versions = createMemo(() =>
    list()
      ?.result?.files.map((file) => `${file.file}:${file.version}`)
      .join("|"),
  )

  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  createEffect(
    on([key, visible, isStale, loading] as const, ([current, shown, outdated, busyLoading], previous) => {
      clearTimeout(timer)
      if (!shown || busyLoading) return
      const target = untrack(input)
      const entry = untrack(() => lists[current])
      if (!entry || (!entry.result && !entry.error)) return void load(target)
      // Coming back to a list shows it and refreshes it at once (edits made outside the app send no event);
      // changes while it is on screen wait a moment
      const switched = !previous || previous[0] !== current || !previous[1]
      if (!outdated && !switched) return
      timer = setTimeout(() => void load(target), switched ? 0 : REFRESH)
    }),
  )
  // Refresh once more when the agent finishes a turn
  createEffect(
    on(
      () => !!sessionID() && busy(sessionID()!),
      (now, before) => before && !now && stale(directory()),
      { defer: true },
    ),
  )
  // Prefetch details of the list on screen whenever its files change
  createEffect(
    on([key, visible, versions] as const, ([, shown, files]) => {
      const result = untrack(() => list()?.result)
      if (shown && files !== undefined && result) prefetch(untrack(input), result.files)
    }),
  )

  const failed = (error: Error & { status?: number }) => {
    if (error.status === 409) {
      toast({ kind: "info", title: t("review.stale") })
      void load(input())
      return
    }
    toast({ kind: "error", title: t("error.request", { message: error.message }), error: error })
  }

  /** Accepts or rejects: no files means everything; a file without hunks means the whole file */
  const decide = async (decision: "accept" | "reject", files?: { file: string; hunks?: string[] }[]) => {
    const current = list()?.result
    const targets: { file: string; hunks?: string[] }[] =
      files ?? current?.files.map((file) => ({ file: file.file })) ?? []
    const count = targets.reduce((sum, target) => {
      const file = current?.files.find((item) => item.file === target.file)
      return sum + (target.hunks?.length ?? file?.hunks ?? 0)
    }, 0)
    const target = input()
    const result = await call(
      client(target.directory).review.decide({ ...params(target), decision, ...(files ? { files } : {}) }),
    ).catch(failed)
    if (!result) return
    show(keyOf(target), result)
    setReview("last", { decision, count })
  }

  const undo = async () => {
    const target = input()
    const result = await call(client(target.directory).review.undo(params(target))).catch(failed)
    if (!result) return
    show(keyOf(target), result)
    setReview("last", undefined)
    toast({ kind: "info", title: t("review.undone") })
  }

  const auto = createMemo(() => autoExpand(list()?.result?.files ?? []))
  const fileState = (file: ReviewFile) => opened[openKey(key(), file.file)]
  const setFile = (file: ReviewFile, change: { open?: boolean; all?: boolean }) =>
    setOpened(openKey(key(), file.file), (current) => ({ ...current, ...change }))

  return {
    data: () => list()?.result,
    error: () => list()?.error,
    /** Nothing to show yet: the first fetch of this list is running */
    loading: () => !list()?.result && !list()?.error,
    /** Showing a list while a newer one is fetched */
    refreshing: () => !!list()?.result && !!list()?.loading,
    decide,
    undo,
    refetch: () => load(input()),
    detail: (file: ReviewFile) => cell(detailKey(key(), file)).get(),
    loadDetail: (file: ReviewFile) => loadDetail(input(), file),
    loadTokens: (file: ReviewFile, lang: string | undefined) => loadTokens(input(), file, lang),
    /** Open unless closed by hand; files open on their own when the review is small and they are not viewed */
    open: (file: ReviewFile) => fileState(file)?.open ?? (auto() && !isSeen(file)),
    setOpen: (file: ReviewFile, open: boolean | undefined) => setFile(file, { open }),
    /** Every line is shown, not just the first ones */
    all: (file: ReviewFile) => !!fileState(file)?.all,
    showAll: (file: ReviewFile) => setFile(file, { all: true }),
  }
}

export const commentsOf = (sessionID: string | undefined) => (sessionID ? (review.comments[sessionID] ?? []) : [])

/** Line the comment attaches to: the first changed new line, else the old line, else the hunk start */
export function commentLine(hunk: ReviewHunk) {
  const changed = hunk.lines.filter((line) => line.kind !== "context")
  return changed.find((item) => item.new !== undefined)?.new ?? changed[0]?.old ?? hunk.newStart
}

/** Hunk selected for a comment, resolved from the files whose details are loaded */
export function commentingOn(
  files: readonly ReviewFile[],
  detail: (file: ReviewFile) => { detail?: { hunks: ReviewHunk[] } },
) {
  const id = review.commenting
  if (!id) return
  for (const file of files) {
    const hunk = detail(file).detail?.hunks.find((item) => item.id === id)
    if (hunk) return { file: file.file, hunk }
  }
}

export function addComment(sessionID: string, file: string, hunk: ReviewHunk, text: string) {
  const line = commentLine(hunk)
  const excerpt = hunk.lines
    .filter((item) => item.kind !== "context")
    .slice(0, 12)
    .map((item) => `${item.kind === "add" ? "+" : "-"}${item.text}`)
    .join("\n")
  setReview("comments", sessionID, (list = []) => [...list, { id: next++, file, line, text, excerpt }])
  setReview("commenting", undefined)
}

export function removeComment(sessionID: string, id: number) {
  setReview("comments", sessionID, (list = []) => list.filter((item) => item.id !== id))
}

/** Turns the collected comments into one message */
export function commentMessage(comments: Comment[]) {
  const body = comments
    .map((comment) => `- ${comment.file}:${comment.line} — ${comment.text}\n\n\`\`\`diff\n${comment.excerpt}\n\`\`\``)
    .join("\n\n")
  return `${t("review.commentPrompt")}\n\n${body}`
}

export function clearComments(sessionID: string) {
  setReview("comments", sessionID, [])
}

/** Total hunks in this review and how many are accepted (marked, in the branch scope) */
export function progress(data: ReviewResult | undefined) {
  const files = data?.files ?? []
  return {
    total: files.reduce((sum, file) => sum + file.hunks, 0),
    done: files.reduce((sum, file) => sum + file.accepted, 0),
  }
}

/** A file is marked viewed for one version of its contents; once they change, it is no longer viewed */
const fingerprint = (file: ReviewFile) => `${file.file}:${file.version}`

const SEEN = "review.seen"
const [seen, setSeen] = createStore<Record<string, true>>({})
void storage.get<Record<string, true>>(SEEN, {}).then((saved) => setSeen(saved))

export const isSeen = (file: ReviewFile) => !!seen[fingerprint(file)]

export function toggleSeen(file: ReviewFile) {
  const key = fingerprint(file)
  setSeen(produce((draft) => (draft[key] ? delete draft[key] : (draft[key] = true))))
  // Keep only the most recent entries so the record does not grow forever
  void storage.set(SEEN, Object.fromEntries(Object.entries(seen).slice(-500)))
}
