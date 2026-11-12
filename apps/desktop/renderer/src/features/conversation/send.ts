import type { CodeWorktree, ModelMessage, ModelPart } from "@merakcode/sdk"
import { client } from "../../state/client"
import { choice } from "../../state/models"
import { renameSession, session } from "../../state/store"
import type { Submission } from "./composer"
import type { Turn } from "./turns"

export function submissionParts(submission: Submission): ModelPart[] {
  const parts: ModelPart[] = submission.text ? [{ text: submission.text }] : []
  for (const file of submission.files) {
    const match = /^data:[^,]*;base64,([A-Za-z0-9+/=]*)$/.exec(file.url)
    if (!match) throw new Error("MRK-3001")
    try {
      atob(match[1]!)
    } catch {
      throw new Error("MRK-3001")
    }
    if (file.mime.startsWith("image/")) parts.push({ image: { mime: file.mime, data: match[1] } })
    else parts.push({ document: { mime: file.mime, name: file.filename, data: match[1]! } })
  }
  return parts
}

export async function send(id: string, directory: string, submission: Submission, extendBudget = false) {
  const selected = choice(id, directory)
  if (!selected.model) throw new Error("MRK-3001")
  await (
    await client()
  ).session.send({
    session: id,
    parts: submissionParts(submission),
    extendBudget,
    selection: { provider: selected.model.providerID, model: selected.model.modelID, thinking: selected.variant },
  })
  if (!session(id)?.title) await renameSession(id, submission.text.slice(0, 80) || submission.files[0]?.filename || "")
}

export async function stop(id: string) {
  await (await client()).session.cancel({ session: id })
}

/** Reverts to before a message: it and the later ones are hidden and the files the agent changed come back. */
export async function revertTo(id: string, mark: string) {
  await (await client()).session.revert({ session: id, message: mark })
}

/** Undoes the latest revert. */
export async function restore(id: string) {
  await (await client()).session.unrevert({ session: id })
}

/** The text and attachments of a user message, for editing it or sending it again. */
export function submissionOf(message: ModelMessage): Submission {
  const parts = message.parts ?? []
  const text = parts.flatMap((part) => (part.text && !part.synthetic ? [part.text] : [])).join("\n")
  const files = parts.flatMap((part) => {
    if (part.image) {
      const mime = part.image.mime
      return [{ filename: "image", mime, url: part.image.url || `data:${mime};base64,${part.image.data ?? ""}` }]
    }
    if (part.document)
      return [
        {
          filename: part.document.name ?? "document",
          mime: part.document.mime,
          url: `data:${part.document.mime};base64,${part.document.data}`,
        },
      ]
    return []
  })
  return { text, files }
}

/** Retries a turn: reverts to its user message and sends the same content again. */
export async function retry(id: string, directory: string, turn: Turn) {
  if (!turn.user || !turn.mark) throw new Error("MRK-4007")
  const submission = submissionOf(turn.user)
  await revertTo(id, turn.mark)
  await send(id, directory, submission)
}

/** A worktree being prepared for the first message: the key makes asking again return the same one. */
export type WorktreeAttempt = { key: string; info?: CodeWorktree }

/** Creates the worktree of an attempt once, starting from the chosen branch, and keeps it through later failures. */
export async function createWorktree(directory: string, base?: string, attempt?: WorktreeAttempt) {
  const pending = attempt ?? { key: `task-${crypto.randomUUID().slice(0, 8)}` }
  pending.info ??= await (await client()).worktree.create({ directory, key: pending.key, ...(base ? { base } : {}) })
  return pending.info
}
