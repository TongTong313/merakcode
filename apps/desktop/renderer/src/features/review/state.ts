/**
 * Review data and actions, shared by the panel and the maximized view.
 *
 * Scopes: this turn / whole conversation (the agent's changes), unstaged / staged / branch (git). The engine computes
 * the hunks (review.get) and applies accept / reject by hunk id (review.decide); after it updates the baseline or the
 * files it emits review.updated. Undo is review.undo. A stale hunk id (the file changed again) returns 409, which shows
 * a notice and refetches. Comments live only in the UI and are sent to the agent together.
 */
import type { ReviewFile, ReviewHunk, ReviewResult, ReviewScope } from "@merakcode/sdk/client"
import { createEffect, createResource, createSignal, on, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { busy, listen, messagesOf } from "../../state/store"
import { showTab } from "../../state/ui"
import { storage } from "../../lib/bridge"
import { toast } from "../../ui/toast"

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

const SCOPES: ReviewScope[] = ["turn", "session", "unstaged", "staged", "branch"]
export const scopeOptions = (git: boolean, conversation: boolean) =>
  SCOPES.map((scope) => ({
    value: scope,
    label: t(`review.scope.${scope}`),
    disabled: ["unstaged", "staged", "branch"].includes(scope) ? !git : !conversation,
  }))

/**
 * Review data for one conversation. Refetched when the scope changes, the engine reports a review update, the agent
 * finishes a turn, or files change (git scopes).
 */
export function useReview(sessionID: () => string | undefined, directory: () => string) {
  const [version, setVersion] = createSignal(0)
  const bump = () => setVersion((value) => value + 1)
  const key = () => {
    const scope = review.scope
    const id = sessionID()
    const messageID = scope === "turn" && id ? turnOf(id) : undefined
    return { scope, sessionID: id, messageID, base: review.base, directory: directory(), version: version() }
  }
  const [data, { mutate, refetch }] = createResource(key, async (input): Promise<ReviewResult | undefined> => {
    // No conversation yet: only the git scopes have data
    const conversation = input.scope === "turn" || input.scope === "session"
    if ((conversation && !input.sessionID) || (input.scope === "turn" && !input.messageID))
      return { scope: input.scope, actions: { accept: false, reject: false }, files: [] }
    return call(
      client(input.directory).review.get({
        scope: input.scope,
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        ...(input.messageID ? { messageID: input.messageID } : {}),
        ...(input.base ? { base: input.base } : {}),
      }),
    )
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const later = () => {
    clearTimeout(timer)
    timer = setTimeout(bump, 300)
  }
  onCleanup(() => clearTimeout(timer))
  const stop = listen((_, event) => {
    if (event.type === "review.updated" && (!event.properties.sessionID || event.properties.sessionID === sessionID()))
      return later()
    if (event.type === "file.watcher.updated" && !["turn", "session"].includes(review.scope)) return later()
    if (event.type === "message.part.updated") {
      const part = event.properties.part
      if (
        part.type === "tool" &&
        part.state.status === "completed" &&
        ["edit", "write", "multi_edit", "bash"].includes(part.tool)
      )
        later()
    }
  })
  onCleanup(stop)
  // Refetch once more when the agent finishes a turn
  createEffect(
    on(
      () => !!sessionID() && busy(sessionID()!),
      (now, before) => before && !now && later(),
      { defer: true },
    ),
  )

  const params = () => {
    const input = key()
    return {
      scope: input.scope,
      ...(input.sessionID ? { sessionID: input.sessionID } : {}),
      ...(input.messageID ? { messageID: input.messageID } : {}),
      ...(input.base ? { base: input.base } : {}),
    }
  }

  const failed = (error: Error & { status?: number }) => {
    if (error.status === 409) {
      toast({ kind: "info", title: t("review.stale") })
      void refetch()
      return
    }
    toast({ kind: "error", title: t("error.request", { message: error.message }), error: error })
  }

  /** Accepts or rejects: no files means everything; a file without hunks means the whole file */
  const decide = async (decision: "accept" | "reject", files?: { file: string; hunks?: string[] }[]) => {
    const current = data()
    const targets: { file: string; hunks?: string[] }[] =
      files ?? current?.files.map((file) => ({ file: file.file })) ?? []
    const count = targets.reduce((sum, target) => {
      const file = current?.files.find((item) => item.file === target.file)
      return sum + (target.hunks?.length ?? file?.hunks.length ?? 0)
    }, 0)
    const result = await call(
      client(directory()).review.decide({ ...params(), decision, ...(files ? { files } : {}) }),
    ).catch(failed)
    if (!result) return
    mutate(result)
    setReview("last", { decision, count })
  }

  const undo = async () => {
    const result = await call(client(directory()).review.undo(params())).catch(failed)
    if (!result) return
    mutate(result)
    setReview("last", undefined)
    toast({ kind: "info", title: t("review.undone") })
  }

  // After the scope (or base branch) changes, hide the previous result until the new one arrives; otherwise the
  // staged scope would briefly show unstaged files
  const view = Object.assign(
    () => {
      const value = data()
      if (!value || value.scope !== review.scope) return undefined
      if (value.scope === "branch" && review.base && value.base !== review.base) return undefined
      return value
    },
    {
      get error() {
        return data.error as unknown
      },
      get loading() {
        return data.loading
      },
    },
  )

  return { data: view, decide, undo, refetch }
}

export const commentsOf = (sessionID: string | undefined) => (sessionID ? (review.comments[sessionID] ?? []) : [])

export function addComment(sessionID: string, file: ReviewFile, hunk: ReviewHunk, text: string) {
  const changed = hunk.lines.filter((line) => line.kind !== "context")
  const line = changed.find((item) => item.new !== undefined)?.new ?? changed[0]?.old ?? hunk.newStart
  const excerpt = changed
    .slice(0, 12)
    .map((item) => `${item.kind === "add" ? "+" : "-"}${item.text}`)
    .join("\n")
  setReview("comments", sessionID, (list = []) => [...list, { id: next++, file: file.file, line, text, excerpt }])
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
    total: files.reduce((sum, file) => sum + file.hunks.length, 0),
    done: files.reduce((sum, file) => sum + file.accepted, 0),
  }
}

/** Fingerprint of the file contents: once the contents change, the file is no longer marked as viewed */
function fingerprint(file: ReviewFile) {
  const text = `${file.status}\u0000${file.after ?? ""}\u0000${file.hunks.map((hunk) => hunk.id).join(",")}`
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0
  return `${file.file}:${(hash >>> 0).toString(36)}`
}

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
