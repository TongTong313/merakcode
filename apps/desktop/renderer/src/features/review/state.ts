/**
 * Review data and actions, shared by the panel and the maximized view.
 *
 * Scopes: this turn / whole conversation (the agent's pending changes). The engine lists the
 * files with counts and a version each (review.get) and returns one file's hunks on request (review.file). Accept /
 * reject go by hunk id (review.decide) and return the new list. A stale version or hunk id returns 409, which shows a
 * notice and refetches the list. Comments live only in the UI and are sent to the agent together.
 *
 * Lists are cached per review and file details per version (see cache.ts): switching back to a scope shows it at
 * once while it refreshes, and a refresh only refetches the files that changed. Events only mark lists stale; the
 * review on screen refreshes itself, and fetches details in the background while idle.
 */
import type { ReviewFile, ReviewFileDetail, ReviewResult, ReviewScope } from "@merakcode/sdk/client"
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
import { checkoutOf, gitDirectory, onCheckoutChange, registerDirty, refreshBranches, identityOf } from "../../state/git"
import { busy, listen, messagesOf, refreshVcs } from "../../state/store"
import { showTab } from "../../state/ui"
import { toast } from "../../ui/toast"
import { autoExpand, detailKey, detailSize, keyOf, PREFETCH, prefetchQueue, type ReviewKey } from "./cache"

import { commentLocation, excerptOf, refreshTarget, type CommentTarget, type SelectedLine } from "./selection"

export type Comment = CommentTarget & { id: number; text: string }

type Review = {
  directory?: string
  scope: ReviewScope
  /** For the turn scope: which turn (user message id); defaults to the last one */
  messageID?: string
  /** File to scroll to */
  focus?: string
  reveal?: { hunk: string; index: number; side: CommentTarget["side"] }
  /** Selected code and its review context. */
  commenting?: CommentTarget
  selecting?: CommentTarget
  comments: Record<string, Comment[]>
  style: "unified" | "split"
}

export const [review, setReview] = createStore<Review>({ scope: "turn", comments: {}, style: "split" })

export function selectScope(scope: ReviewScope) {
  setReview({ scope, messageID: undefined })
}

let next = 1

/** Opens the review, optionally at a scope, a turn, or a file */
export function openReview(view: { scope?: ReviewScope; messageID?: string; file?: string } = {}) {
  setReview({
    ...(view.scope ? { scope: view.scope } : {}),
    messageID: view.messageID,
    focus: view.file,
  })
  showTab("review")
}

/** User message for the turn scope: the chosen one, or the last one */
function turnOf(sessionID: string) {
  const messages = messagesOf(sessionID)
  return messages.some((message) => message.role === "user" && message.id === review.messageID)
    ? review.messageID
    : messages.findLast((message) => message.role === "user")?.id
}

export const scopeOptions = () =>
  (["turn", "session"] as const).map((scope) => ({ value: scope, label: t(`review.scope.${scope}`) }))

// Lists: one per review, refetched when stale

type List = { input: ReviewKey; result?: ReviewResult; loading: boolean; stale: boolean; error?: Error }
const [lists, setLists] = createStore<Record<string, List>>({})
const controllers = new Map<string, AbortController>()
const currentContext = (input: ReviewKey) => (checkoutOf(input.directory) ?? null) === (input.checkout ?? null)

const params = (input: ReviewKey) => ({
  scope: input.scope,
  sessionID: input.sessionID!,
  ...(input.messageID ? { messageID: input.messageID } : {}),
})

const empty = (input: ReviewKey): ReviewResult | undefined => {
  if (!input.sessionID || (input.scope === "turn" && !input.messageID))
    return {
      scope: input.scope,
      checkout: input.checkout ?? null,
      actions: { accept: false, reject: false },
      files: [],
    }
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
    if (controller.signal.aborted) return
    if (result.checkout !== (checkoutOf(input.directory) ?? null)) {
      if (!currentContext(input)) return
      await refreshVcs(input.directory)
    }
    if (!controller.signal.aborted && result.checkout === (checkoutOf(input.directory) ?? null))
      show({ ...input, checkout: result.checkout }, result)
  } catch (error) {
    if (!controller.signal.aborted) setLists(key, { loading: false, error: error as Error })
  } finally {
    if (controllers.get(key) === controller) controllers.delete(key)
  }
}

/** Puts a new list in place: files keep their identity by path, so open files and their state stay */
function show(input: ReviewKey, result: ReviewResult) {
  const key = keyOf(input)
  batch(() => {
    setLists(key, (previous) => ({ ...previous, input, loading: false, stale: false, error: undefined }))
    setLists(key, "result", reconcile(result, { key: "file" }))
    setLists(key, { loading: false, error: undefined })
  })
  prune(key, result.files)
  if (input.sessionID) {
    const files = new Set(result.files.map((file) => file.file))
    setReview("comments", input.sessionID, (comments = []) =>
      comments.map((comment) => {
        const applies =
          sameDir(gitDirectory(comment.directory), gitDirectory(input.directory)) &&
          (input.scope === "session" || (comment.scope === input.scope && comment.messageID === input.messageID))
        return applies && !files.has(comment.file) && !comment.stale ? { ...comment, stale: true } : comment
      }),
    )
  }
}

const statusTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; refs: boolean }>()

/** Reloads git counts with the review, after a burst of file events has settled */
function refreshStatus(directory: string, refs = false) {
  const pending = statusTimers.get(directory)
  if (pending) clearTimeout(pending.timer)
  statusTimers.set(directory, {
    refs: refs || !!pending?.refs,
    timer: setTimeout(() => {
      const refs = statusTimers.get(directory)?.refs
      statusTimers.delete(directory)
      void refreshVcs(directory)
      if (refs) void refreshBranches(directory)
    }, 1000),
  })
}

/** Marks every list of a directory stale; the one on screen refreshes itself */
function stale(directory: string, refs = false) {
  refreshStatus(directory, refs)
  for (const [key, list] of Object.entries(lists))
    if (sameDir(list.input.directory, directory)) setLists(key, "stale", true)
}

let watching = false
function watch() {
  if (watching) return
  watching = true
  onCheckoutChange((directory, change) => {
    for (const [key, list] of Object.entries(lists)) {
      if (!sameDir(gitDirectory(list.input.directory), directory)) continue
      controllers.get(key)?.abort()
      controllers.delete(key)
      setLists(key, undefined!)
      for (const detail of details.keys()) if (detail.startsWith(`${key}\u0000`)) details.delete(detail)
    }
    prefetching++
    const shown = review.directory && sameDir(gitDirectory(review.directory), directory)
    if (shown && change.branchChanged) setReview({ commenting: undefined, selecting: undefined })
    if (change.branchChanged) {
      for (const [sessionID, value] of commentDirectories) {
        if (!sameDir(gitDirectory(value), directory)) continue
        setReview("comments", sessionID, (comments = []) => comments.map((comment) => ({ ...comment, stale: true })))
      }
    }
  })
  listen((directory, event) => {
    if (event.type === "review.updated") return stale(directory)
    if (event.type === "file.watcher.updated") {
      const file = event.properties.file.replace(/\\/g, "/")
      return stale(directory, file.includes("/refs/") || file.endsWith("/packed-refs"))
    }
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
    client(input.directory).review.file({
      ...params(input),
      file: file.file,
      version: file.version,
      expectedCheckout: input.checkout ?? null,
    }),
  ).then(
    (detail) => {
      if (!currentContext(input) || details.get(key) !== target) return undefined
      target.set({ detail })
      return detail
    },
    (error: Error & { status?: number }) => {
      if (!currentContext(input) || details.get(key) !== target) return undefined
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
  if (currentContext(input) && details.get(key) === target)
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
function useReviewList(
  sessionID: () => string | undefined,
  directory: () => string,
  visible: () => boolean,
  scopeOf: () => ReviewScope,
) {
  watch()
  const input = createMemo(
    (): ReviewKey => {
      const scope = scopeOf()
      const id = sessionID()
      const messageID = scope === "turn" && id ? turnOf(id) : undefined
      return {
        directory: directory(),
        scope,
        sessionID: id,
        messageID,
        checkout: checkoutOf(directory()) ?? null,
      }
    },
    undefined,
    { equals: (a, b) => keyOf(a) === keyOf(b) },
  )
  const key = () => keyOf(input())
  const list = () => lists[key()]
  const isStale = createMemo(() => !!list()?.stale)
  const loading = createMemo(() => !!list()?.loading)

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
      if (switched) return void load(target)
      timer = setTimeout(() => void load(target), REFRESH)
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
  return { input, key, list, refetch: () => load(input()) }
}

/** Git navigation needs only the pending file names, without loading review details. */
export function usePendingReview(sessionID: () => string | undefined, directory: () => string) {
  const { list, refetch } = useReviewList(
    sessionID,
    directory,
    () => true,
    () => "session",
  )
  return { files: () => list()?.result?.files.map((file) => file.file) ?? [], refetch }
}

/** Review details, presentation state and decisions are owned by the review view. */
export function useReview(
  sessionID: () => string | undefined,
  directory: () => string,
  visible: () => boolean = () => true,
) {
  const { input, key, list, refetch } = useReviewList(sessionID, directory, visible, () => review.scope)
  const [working, setWorking] = createSignal(false)
  createEffect(
    on([directory, visible], ([value, shown]) => {
      if (shown) setReview("directory", value)
    }),
  )
  const versions = createMemo(() =>
    list()
      ?.result?.files.map((file) => `${file.file}:${file.version}`)
      .join("|"),
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
    if (!current || working() || list()?.loading || !currentContext(input())) return
    const targets: { file: string; hunks?: string[] }[] =
      files ?? current?.files.map((file) => ({ file: file.file })) ?? []
    const target = input()
    setWorking(true)
    try {
      const result = await call(
        client(target.directory).review.decide({
          ...params(target),
          decision,
          expectedCheckout: current.checkout,
          files: targets.map((file) => ({
            ...file,
            version: current.files.find((item) => item.file === file.file)!.version,
          })),
        }),
      ).catch(failed)
      if (!result || !currentContext(target) || keyOf(target) !== key()) return
      if (result.checkout !== (target.checkout ?? null)) {
        await refreshVcs(target.directory)
        return
      }
      show(target, result)
      stale(target.directory)
    } finally {
      setWorking(false)
    }
  }

  const undo = async () => {
    const target = input()
    const current = list()?.result
    if (!current || working() || list()?.loading || !currentContext(target)) return
    setWorking(true)
    try {
      const result = await call(
        client(target.directory).review.undo({ ...params(target), expectedCheckout: current.checkout }),
      ).catch(failed)
      if (!result || !currentContext(target) || keyOf(target) !== key()) return
      if (result.checkout !== (target.checkout ?? null)) {
        await refreshVcs(target.directory)
        return
      }
      show(target, result)
      toast({ kind: "info", title: t("review.undone") })
    } finally {
      setWorking(false)
    }
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
    refreshing: () => !!list()?.result && (!!list()?.loading || !!list()?.stale),
    working,
    decide,
    undo,
    refetch,
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

/** Inline selections belong to one checkout, conversation and review turn. */
export function commentInView(target: CommentTarget, directory: string, sessionID: string | undefined) {
  return (
    sameDir(gitDirectory(target.directory), gitDirectory(directory)) &&
    target.sessionID === sessionID &&
    target.branch === identityOf(directory)?.branch &&
    target.scope === review.scope &&
    target.messageID === (review.scope === "turn" && sessionID ? turnOf(sessionID) : undefined)
  )
}

export const commentsOf = (sessionID: string | undefined, directory?: string) =>
  (sessionID ? (review.comments[sessionID] ?? []) : []).filter(
    (comment) => !directory || sameDir(gitDirectory(comment.directory), gitDirectory(directory)),
  )

export function beginComment(
  directory: string,
  sessionID: string,
  file: string,
  version: string,
  rows: SelectedLine[],
  side: CommentTarget["side"] = "unified",
  compose = true,
) {
  if (!rows.length) return
  const messageID = review.scope === "turn" ? turnOf(sessionID) : undefined
  const context = gitDirectory(directory)
  const branch = identityOf(directory)?.branch
  const previous = review.commenting
  const continuation =
    previous?.stale && commentInView(previous, directory, sessionID)
      ? { relocating: previous.key, editing: previous.editing }
      : {}
  const key = continuation.relocating
    ? crypto.randomUUID()
    : JSON.stringify([
        context,
        branch,
        sessionID,
        review.scope,
        messageID,
        file,
        side,
        rows.map((row) => [row.hunk, row.index]),
        continuation.editing,
      ])
  const target = {
    key,
    directory: context,
    branch,
    sessionID,
    scope: review.scope,
    messageID,
    file,
    version,
    rows,
    side,
    stale: false,
    editing: undefined,
    relocating: undefined,
    ...continuation,
  }
  setReview("selecting", compose ? undefined : target)
  if (compose) setReview("commenting", target)
}

export function refreshCommentAnchors(directory: string, sessionID: string, detail: ReviewFileDetail) {
  const matches = (target: CommentTarget) => commentInView(target, directory, sessionID) && target.file === detail.file
  for (const key of ["commenting", "selecting"] as const) {
    const target = review[key]
    if (!target || !matches(target)) continue
    const next = refreshTarget(target, detail)
    if (next !== target) setReview(key, next)
  }
  for (const comment of commentsOf(sessionID)) {
    if (!matches(comment)) continue
    const next = refreshTarget(comment, detail)
    if (next !== comment) setReview("comments", sessionID, (item) => item.id === comment.id, next)
  }
}

export function revealComment(comment: Comment, edit = false) {
  const end = comment.rows.at(-1)
  const branch = identityOf(comment.directory)?.branch
  setReview({
    scope: comment.scope,
    messageID: comment.messageID,
    focus: comment.file,
    reveal: end ? { hunk: end.hunk, index: end.index, side: comment.side } : undefined,
    commenting: edit
      ? {
          ...comment,
          key: JSON.stringify(["edit", comment.sessionID, comment.id]),
          branch,
          stale: comment.stale || branch !== comment.branch,
          editing: comment.id,
        }
      : undefined,
  })
}

const commentDirectories = new Map<string, string>()

export function commentDirectory(sessionID: string, directory: string) {
  const previous = commentDirectories.get(sessionID)
  if (previous && !sameDir(gitDirectory(previous), gitDirectory(directory)))
    registerDirty(previous, `comments:${sessionID}`, 0)
  commentDirectories.set(sessionID, directory)
  registerDirty(directory, `comments:${sessionID}`, commentsOf(sessionID, directory).length)
}

function syncComments(sessionID: string) {
  const directory = commentDirectories.get(sessionID)
  if (directory) registerDirty(directory, `comments:${sessionID}`, commentsOf(sessionID, directory).length)
}

export function addComment(sessionID: string, target: CommentTarget, text: string) {
  setReview("comments", sessionID, (list = []) =>
    target.editing === undefined || !list.some((comment) => comment.id === target.editing)
      ? [...list, { ...target, id: next++, text, editing: undefined, relocating: undefined }]
      : list.map((comment) =>
          comment.id === target.editing
            ? { ...target, id: comment.id, text, editing: undefined, relocating: undefined }
            : comment,
        ),
  )
  syncComments(sessionID)
  setReview("commenting", undefined)
}

export function removeComment(sessionID: string, id: number) {
  setReview("comments", sessionID, (list = []) => list.filter((item) => item.id !== id))
  syncComments(sessionID)
}

/** Turns the collected comments into one message */
export function commentMessage(comments: Comment[]) {
  const body = comments
    .map((comment) => `- ${commentLocation(comment)} — ${comment.text}\n\n\`\`\`diff\n${excerptOf(comment)}\n\`\`\``)
    .join("\n\n")
  return `${t("review.commentPrompt")}\n\n${body}`
}

export function clearComments(sessionID: string, submitted?: Comment[], directory?: string) {
  setReview("comments", sessionID, (comments = []) =>
    comments.filter((comment) => {
      if (directory && !sameDir(gitDirectory(comment.directory), gitDirectory(directory))) return true
      return submitted
        ? !submitted.some(
            (sent) =>
              sent.id === comment.id &&
              sent.version === comment.version &&
              sent.scope === comment.scope &&
              sent.messageID === comment.messageID &&
              sent.branch === comment.branch &&
              sent.side === comment.side &&
              commentMessage([sent]) === commentMessage([comment]),
          )
        : false
    }),
  )
  syncComments(sessionID)
}

/** Number of pending hunks in this review. */
export function progress(data: ReviewResult | undefined) {
  const files = data?.files ?? []
  return {
    total: files.reduce((sum, file) => sum + file.hunks, 0),
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
