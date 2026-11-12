/** Repository diffs, viewed files and comment drafts shared by the review views. */
import { reviewData, type ReviewFile, type ReviewFileDetail, type ReviewResult, type ReviewScope } from "./data"
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
import { tokenize } from "../../lib/tokens"
import { client } from "../../state/client"
import {
  checkoutOf,
  gitDirectory,
  sameDirectory,
  onCheckoutChange,
  registerDirty,
  identityOf,
  resolveDirectory,
} from "../../state/git"
import { busy, listen } from "../../state/store"
import { setUi } from "../../state/ui"
import { openPanel } from "../panel/workspace"
import { autoExpand, detailKey, detailSize, keyOf, PREFETCH, prefetchQueue, type ReviewKey } from "./cache"

import { commentLocation, excerptOf, refreshTarget, type CommentTarget, type SelectedLine } from "./selection"
import { commentTargetSchema } from "./selection"
import z from "zod"

export type Comment = CommentTarget & { id: number; text: string }

type Review = {
  directory?: string
  scope: ReviewScope
  /** For the turn scope: which turn (user message id); defaults to the last one */
  messageID?: string
  /** File to scroll to */
  focus?: string
  reveal?: { hunk: string; index: number; side: CommentTarget["side"]; directory: string; sessionID: string }
  /** Selected code and its review context. */
  commenting?: CommentTarget
  selecting?: CommentTarget
  comments: Record<string, Comment[]>
  style: "unified" | "split"
  files: Record<string, { open?: boolean; all?: boolean }>
  seen: Record<string, true>
  active?: { file: string; id?: string }
}

export const [review, setReview] = createStore<Review>({
  scope: "session",
  comments: {},
  style: "split",
  files: {},
  seen: {},
})

let next = 1

export function restoreReview(value: unknown) {
  const schema = z.object({
    directory: z.string().optional(),
    // Layouts saved by older versions say "turn"; every review is now of the whole conversation
    scope: z
      .enum(["turn", "session"])
      .transform(() => "session" as const)
      .default("session"),
    messageID: z.string().optional(),
    focus: z.string().optional(),
    // A reveal is transient: one saved without its owner is dropped instead of discarding the comments beside it
    reveal: z
      .object({
        hunk: z.string(),
        index: z.number(),
        side: z.enum(["old", "new", "unified"]),
        directory: z.string(),
        sessionID: z.string(),
      })
      .optional()
      .catch(undefined),
    commenting: commentTargetSchema.optional(),
    selecting: commentTargetSchema.optional(),
    comments: z
      .record(z.string(), z.array(commentTargetSchema.extend({ id: z.number(), text: z.string() })))
      .default({}),
    style: z.enum(["unified", "split"]).default("split"),
    files: z.record(z.string(), z.object({ open: z.boolean().optional(), all: z.boolean().optional() })).default({}),
    seen: z.record(z.string(), z.literal(true)).default({}),
    active: z.object({ file: z.string(), id: z.string().optional() }).optional(),
  })
  const restored = schema.safeParse(value)
  const result = restored.success
    ? restored.data
    : { scope: "session" as const, comments: {}, style: "split" as const, files: {}, seen: {} }
  result.files = Object.fromEntries(
    Object.entries(result.files).map(([key, value]) => {
      const parts = key.split("\u0000")
      if (parts.length >= 6) parts[4] = ""
      return [parts.join("\u0000"), value]
    }),
  )
  setReview(reconcile(result))
  next = Math.max(
    next,
    ...Object.values(result.comments)
      .flat()
      .map((comment) => comment.id + 1),
  )
}

/** Opens the review, optionally at a scope, a turn, or a file */
export function openReview(view: { scope?: ReviewScope; messageID?: string; file?: string } = {}) {
  setUi({ panel: true, maximized: false })
  void openPanel(
    {
      kind: "review",
      view: {
        scope: view.scope ?? "session",
        messageID: view.messageID,
        focus: view.file,
      },
    },
    true,
  )
}

// Lists: one per review, refetched when stale

type List = { input: ReviewKey; result?: ReviewResult; loading: boolean; stale: boolean; error?: Error }
const [lists, setLists] = createStore<Record<string, List>>({})
const controllers = new Map<string, AbortController>()
const currentContext = (input: ReviewKey) => (checkoutOf(input.directory) ?? null) === (input.checkout ?? null)

/** Fetches a list; a newer request for the same review cancels this one */
async function load(input: ReviewKey) {
  const key = keyOf(input)
  controllers.get(key)?.abort()
  const controller = new AbortController()
  controllers.set(key, controller)
  setLists(key, (current) => ({ ...current, input, loading: true, stale: false }))
  try {
    await resolveDirectory(input.directory)
    const connection = await client()
    const changes = await connection.repo.diff({
      directory: input.directory,
      session: input.base ? undefined : input.sessionID,
      base: input.base ?? (input.sessionID ? undefined : (identityOf(input.directory)?.head ?? undefined)),
    })
    if (controller.signal.aborted || !currentContext(input)) return
    const converted = reviewData(changes ?? [])
    const result: ReviewResult = { scope: "session", checkout: input.checkout ?? null, files: converted.files }
    show(input, result)
    for (const file of result.files) {
      const detail = cell(detailKey(key, file))
      if (!detail.get().detail) detail.set({ detail: converted.details[file.file] })
    }
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
  })
  prune(key, result.files)
  for (const oldest of Object.keys(lists)) {
    if (Object.keys(lists).length <= 32) break
    if (oldest !== key) dropList(oldest)
  }
  if (input.sessionID) {
    const files = new Set(result.files.map((file) => file.file))
    setReview("comments", input.sessionID, (comments = []) =>
      comments.map((comment) => {
        const applies =
          sameDirectory(comment.directory, input.directory) &&
          (input.scope === "session" || (comment.scope === input.scope && comment.messageID === input.messageID))
        return applies && !files.has(comment.file) && !comment.stale ? { ...comment, stale: true } : comment
      }),
    )
  }
}

/** Marks the visible review stale after an operation completes. */
function stale(directory: string) {
  for (const [key, list] of Object.entries(lists))
    if (sameDirectory(list.input.directory, directory)) setLists(key, "stale", true)
}

let watching = false
function watch() {
  if (watching) return
  watching = true
  onCheckoutChange((directory, change) => {
    for (const [key, list] of Object.entries(lists)) {
      if (!sameDirectory(list.input.directory, directory)) continue
      controllers.get(key)?.abort()
      controllers.delete(key)
      setLists(key, undefined!)
      for (const detail of details.keys()) if (detail.startsWith(`${key}\u0000`)) details.delete(detail)
    }
    prefetching++
    const shown = review.directory && sameDirectory(review.directory, directory)
    if (shown && change.branchChanged) setReview({ commenting: undefined, selecting: undefined })
    if (change.branchChanged) {
      for (const [sessionID, value] of commentDirectories) {
        if (!sameDirectory(value, directory)) continue
        setReview("comments", sessionID, (comments = []) => comments.map((comment) => ({ ...comment, stale: true })))
      }
    }
  })
  listen((directory, event) => {
    if (["tool.completed", "turn.finished", "repo.changed", "file.changed"].includes(event.type)) stale(directory)
  })
}

// Details: one per file version, each with its own signal so large hunks are not made reactive

type Tokens = { before?: ThemedToken[][]; after?: ThemedToken[][] }
type Detail = { detail?: ReviewFileDetail; error?: Error; tokens?: Tokens }
type Cell = { get: Accessor<Detail>; set: Setter<Detail> }

const details = new Map<string, Cell>()
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
  const known = cell(detailKey(keyOf(input), file)).get().detail
  if (known) return known
  await load(input)
  return cell(detailKey(keyOf(input), file)).get().detail
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

const openKey = (list: string, file: string) => `${list}\u0000${file}`

function dropList(key: string) {
  controllers.get(key)?.abort()
  controllers.delete(key)
  setLists(key, undefined!)
  for (const detail of details.keys()) if (detail.startsWith(`${key}\u0000`)) details.delete(detail)
}

/** Durable tab snapshots survive runtime eviction; deleted conversations also relinquish dirty ownership. */
export function releaseReview(directory: string, sessionID?: string, deleted = false) {
  for (const [key, list] of Object.entries(lists))
    if (sameDirectory(list.input.directory, directory) && list.input.sessionID === sessionID) dropList(key)
  prefetching++
  if (!sessionID) return
  if (!deleted) return
  commentDirectories.delete(sessionID)
  setReview("comments", sessionID, undefined!)
  registerDirty(directory, `comments:${sessionID}`, 0)
}

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
  base: () => string | undefined,
) {
  watch()
  const input = createMemo(
    (): ReviewKey => {
      const scope = scopeOf()
      const id = sessionID()
      const messageID = undefined
      return {
        directory: directory(),
        scope,
        sessionID: id,
        messageID,
        checkout: checkoutOf(directory()) ?? null,
        base: base(),
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
      // Returning refreshes immediately; changes on screen wait briefly to combine events.
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
    () => undefined,
  )
  return { files: () => list()?.result?.files.map((file) => file.file) ?? [], refetch }
}

/** Review details, presentation state and decisions are owned by the review view. */
export function useReview(
  sessionID: () => string | undefined,
  directory: () => string,
  visible: () => boolean = () => true,
  base: () => string | undefined = () => undefined,
) {
  const { input, key, list, refetch } = useReviewList(sessionID, directory, visible, () => review.scope, base)
  createEffect(
    on([directory, visible], ([value, shown]) => {
      if (shown) setReview("directory", value)
      if (shown && sessionID()) commentDirectory(sessionID()!, value)
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

  const auto = createMemo(() => autoExpand(list()?.result?.files ?? []))
  const presentationKey = () => keyOf({ ...input(), checkout: null })
  const fileState = (file: ReviewFile) => review.files[openKey(presentationKey(), file.file)]
  const setFile = (file: ReviewFile, change: { open?: boolean; all?: boolean }) =>
    setReview("files", openKey(presentationKey(), file.file), (current) => ({ ...current, ...change }))

  return {
    context: key,
    data: () => list()?.result,
    error: () => list()?.error,
    /** Nothing to show yet: the first fetch of this list is running */
    loading: () => !list()?.result && !list()?.error,
    /** Showing a list while a newer one is fetched */
    refreshing: () => !!list()?.result && (!!list()?.loading || !!list()?.stale),
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
    sameDirectory(target.directory, directory) &&
    target.sessionID === sessionID &&
    target.branch === identityOf(directory)?.branch &&
    target.scope === review.scope &&
    target.messageID === undefined
  )
}

export const commentsOf = (sessionID: string | undefined, directory?: string) =>
  (sessionID ? (review.comments[sessionID] ?? []) : []).filter(
    (comment) => !directory || sameDirectory(comment.directory, directory),
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
  const messageID = undefined
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
    reveal: end
      ? {
          hunk: end.hunk,
          index: end.index,
          side: comment.side,
          directory: comment.directory,
          sessionID: comment.sessionID,
        }
      : undefined,
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
  if (previous && !sameDirectory(previous, directory)) registerDirty(previous, `comments:${sessionID}`, 0)
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

export function remainingComments(comments: Comment[], submitted?: Comment[], directory?: string) {
  return comments.filter((comment) => {
    if (directory && !sameDirectory(comment.directory, directory)) return true
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
  })
}

export function clearComments(sessionID: string, submitted?: Comment[], directory?: string) {
  setReview("comments", sessionID, (comments = []) => remainingComments(comments, submitted, directory))
  syncComments(sessionID)
}

/** A file is marked viewed for one version of its contents; once they change, it is no longer viewed */
const fingerprint = (file: ReviewFile) => `${file.file}:${file.version}`

export const isSeen = (file: ReviewFile) => !!review.seen[fingerprint(file)]

export function toggleSeen(file: ReviewFile) {
  const key = fingerprint(file)
  setReview(
    "seen",
    produce((draft) => (draft[key] ? delete draft[key] : (draft[key] = true))),
  )
  // Keep only the most recent entries so the record does not grow forever
  setReview("seen", reconcile(Object.fromEntries(Object.entries(review.seen).slice(-500))))
}
