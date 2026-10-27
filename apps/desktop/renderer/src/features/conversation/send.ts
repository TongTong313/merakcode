import type { Command, FilePartInput, Message, PermissionMode, Worktree } from "@merakcode/sdk/client"
import { MerakCodeError } from "@merakcode/sdk/errors"
import { createStore } from "solid-js/store"
import { t } from "../../i18n"
import { baseName, sameDir } from "../../lib/route"
import { choice, modelKey } from "../../state/models"
import { call, client } from "../../state/client"
import { listen, messagesOf, partsOf, reload, session } from "../../state/store"
import type { Submission } from "./composer"

/**
 * Slash commands available in the composer: the engine's commands (project and user commands, skills, workflows) plus
 * compact, which the UI handles itself
 */
const [commands, setCommands] = createStore<Record<string, Command[]>>({})
export const COMPACT = "compact"

export async function loadCommands(directory: string) {
  if (commands[directory]) return commands[directory]
  const list = await call(client(directory).command.list()).catch(() => [] as Command[])
  setCommands(directory, list)
  return list
}

/** "/name args" → command name and arguments; undefined when the text is not a command */
function parseCommand(text: string) {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return
  return { name: match[1]!, arguments: (match[2] ?? "").trim() }
}

/**
 * Sends a message with the model, reasoning effort and permission mode chosen in the composer.
 * "/command args" runs a command (/compact compacts the context); anything else is a plain message.
 */
export async function send(sessionID: string, directory: string, submission: Submission, mode?: PermissionMode) {
  const info = session(sessionID)
  const dir = info?.directory ?? directory
  const picked = choice(sessionID, directory)
  if (info?.targetBlock || info?.readOnlyReason)
    throw new MerakCodeError({
      code: info.targetBlock ? "MRK-4006" : "MRK-4008",
      message: t("conversation.inputLocked"),
    })
  if (info?.target?.kind === "external") {
    if (submission.files.length)
      throw new MerakCodeError({ code: "MRK-4008", message: t("conversation.external.textOnly") })
    await call(
      client(dir).session.promptAsync({
        sessionID,
        parts: [{ type: "text", text: submission.text }],
        permissionMode: mode ?? picked.mode,
      }),
    )
    return
  }
  const command = parseCommand(submission.text)
  if (command?.name === COMPACT && picked.model) {
    await call(client(dir).session.summarize({ sessionID, ...picked.model }))
    return
  }
  if (command && (await loadCommands(dir)).some((item) => item.name === command.name)) {
    await call(
      client(dir).session.command({
        sessionID,
        command: command.name,
        arguments: command.arguments,
        ...(picked.model ? { model: modelKey(picked.model) } : {}),
        ...(picked.variant ? { variant: picked.variant } : {}),
        permissionMode: mode ?? picked.mode,
        ...(submission.files.length ? { parts: submission.files } : {}),
      }),
    )
    return
  }
  await call(
    client(dir).session.promptAsync({
      sessionID,
      parts: [...(submission.text ? [{ type: "text" as const, text: submission.text }] : []), ...submission.files],
      ...(picked.model ? { model: picked.model } : {}),
      ...(picked.variant ? { variant: picked.variant } : {}),
      permissionMode: mode ?? picked.mode,
    }),
  )
}

export async function stop(sessionID: string, directory: string) {
  await call(client(session(sessionID)?.directory ?? directory).session.abort({ sessionID }))
}

/** Reverts to before this message: it and later messages are hidden, and files the agent changed are restored */
export async function revertTo(sessionID: string, directory: string, messageID: string) {
  if (historyLocked(sessionID))
    throw new MerakCodeError({ code: "MRK-4008", message: t("conversation.external.historyLocked") })
  const dir = session(sessionID)?.directory ?? directory
  await call(client(dir).session.revert({ sessionID, messageID }))
}

/** Undoes the most recent revert */
export async function restore(sessionID: string, directory: string) {
  if (historyLocked(sessionID))
    throw new MerakCodeError({ code: "MRK-4008", message: t("conversation.external.historyLocked") })
  const dir = session(sessionID)?.directory ?? directory
  await call(client(dir).session.unrevert({ sessionID }))
  await reload(sessionID)
}

/** The text the user wrote and the attachments of a user message (for resending and editing) */
export function historyLocked(sessionID: string) {
  const info = session(sessionID)
  return (
    !!info?.targetBlock ||
    !!info?.readOnlyReason ||
    !!info?.takeover ||
    info?.target?.kind === "external" ||
    messagesOf(sessionID).some((message) => message.execution?.kind === "external")
  )
}

export function submissionOf(message: Extract<Message, { role: "user" }>): Submission {
  const parts = partsOf(message.id)
  const text = parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])).join("\n")
  const files = parts.flatMap((part): FilePartInput[] =>
    part.type === "file"
      ? [{ type: "file", mime: part.mime, url: part.url, ...(part.filename ? { filename: part.filename } : {}) }]
      : [],
  )
  return { text, files }
}

/** Retries: reverts to this user message and sends the same content again */
export async function retry(sessionID: string, directory: string, message: Extract<Message, { role: "user" }>) {
  const submission = submissionOf(message)
  await revertTo(sessionID, directory, message.id)
  await send(sessionID, directory, submission)
}

export type WorktreeAttempt = { name: string; requested?: boolean; info?: Worktree }
const worktreeStatus = new Map<string, { ready?: boolean; error?: string }>()
listen((directory, event) => {
  if (event.type === "worktree.ready") worktreeStatus.set(directory, { ready: true })
  if (event.type === "worktree.failed") worktreeStatus.set(directory, { error: event.properties.message })
})

/** Keeps the returned worktree through session or message failures, and resolves ambiguous create results first. */
export async function createWorktree(directory: string, base?: string, attempt?: WorktreeAttempt) {
  const pending = attempt ?? { name: `task-${crypto.randomUUID().slice(0, 8)}` }
  if (!pending.info && pending.requested) {
    const directories = await call(client(directory).worktree.list())
    const found = directories.find((value) => baseName(value) === pending.name)
    if (!found) throw new Error(t("compose.worktreeUncertain"))
    const vcs = await call(client(found).vcs.get())
    if (vcs.branch !== `merakcode/${pending.name}` || !vcs.head) throw new Error(t("compose.worktreeUncertain"))
    pending.info = { directory: found, name: pending.name, branch: vcs.branch }
    if (!vcs.staged && !vcs.unstaged) worktreeStatus.set(found, { ready: true })
  }
  if (!pending.info) {
    pending.requested = true
    try {
      pending.info = await call(
        client(directory).worktree.create({ worktreeCreateInput: { name: pending.name, ...(base ? { base } : {}) } }),
      )
    } catch (error) {
      // A structured rejection happened before creation; a transport failure has an unknown outcome.
      const status = (error as Error & { status?: number }).status
      if (status && status >= 400 && status < 500 && status !== 408) pending.requested = false
      throw error
    }
  }
  const info = pending.info
  const known = [...worktreeStatus].find(([directory]) => sameDir(directory, info.directory))?.[1]
  if (known?.ready) return info
  if (known?.error) throw new Error(known.error)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      reject(new Error(t("compose.creatingWorktree")))
    }, 120_000)
    const stop = listen((dir, event) => {
      if (event.type !== "worktree.ready" && event.type !== "worktree.failed") return
      if (!sameDir(dir, info.directory)) return
      if (event.type === "worktree.ready") {
        clearTimeout(timer)
        stop()
        resolve()
      }
      if (event.type === "worktree.failed") {
        clearTimeout(timer)
        stop()
        reject(new Error(event.properties.message))
      }
    })
  })
  return info
}
