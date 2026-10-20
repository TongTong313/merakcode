import type { Command, FilePartInput, PermissionMode, UserMessage } from "@merakcode/sdk/client"
import { createStore } from "solid-js/store"
import { t } from "../../i18n"
import { choice, modelKey } from "../../state/models"
import { call, client } from "../../state/client"
import { listen, partsOf, reload, session } from "../../state/store"
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
  const dir = session(sessionID)?.directory ?? directory
  await call(client(dir).session.revert({ sessionID, messageID }))
}

/** Undoes the most recent revert */
export async function restore(sessionID: string, directory: string) {
  const dir = session(sessionID)?.directory ?? directory
  await call(client(dir).session.unrevert({ sessionID }))
  await reload(sessionID)
}

/** The text the user wrote and the attachments of a user message (for resending and editing) */
export function submissionOf(message: UserMessage): Submission {
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
export async function retry(sessionID: string, directory: string, message: UserMessage) {
  const submission = submissionOf(message)
  await revertTo(sessionID, directory, message.id)
  await send(sessionID, directory, submission)
}

/** Creates a worktree and returns it once checked out (the engine emits worktree.ready) */
export async function createWorktree(directory: string, base?: string) {
  const info = await call(client(directory).worktree.create({ worktreeCreateInput: base ? { base } : {} }))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      reject(new Error(t("compose.creatingWorktree")))
    }, 120_000)
    const stop = listen((dir, event) => {
      if (dir !== info.directory) return
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
