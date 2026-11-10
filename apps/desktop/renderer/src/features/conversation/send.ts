import type { ModelPart } from "@merakcode/sdk"
import { client } from "../../state/client"
import { choice } from "../../state/models"
import { renameSession, session } from "../../state/store"
import type { Submission } from "./composer"

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
