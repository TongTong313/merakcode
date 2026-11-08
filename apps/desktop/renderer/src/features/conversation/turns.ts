import type { ModelMessage, ModelPart } from "@merakcode/sdk"

export type Turn = { user?: ModelMessage; replies: ModelMessage[] }

/** Canonical messages are ordered; each user message starts the next turn. */
export function turns(messages: readonly ModelMessage[]) {
  const result: Turn[] = []
  for (const message of messages) {
    if (message.role === "user") {
      result.push({ user: message, replies: [] })
      continue
    }
    if (message.role !== "assistant") continue
    if (!result.length) result.push({ replies: [] })
    result.at(-1)!.replies.push(message)
  }
  return result
}

export function answer(turn: Turn): ModelPart[] {
  const last = turn.replies.at(-1)?.parts ?? []
  return last.some((part) => part.toolCall) ? [] : last.filter((part) => part.text || part.image || part.document)
}

export function work(turn: Turn): ModelPart[] {
  const last = turn.replies.at(-1)
  return turn.replies.flatMap((message) =>
    message === last && answer(turn).length
      ? (message.parts ?? []).filter((part) => !part.text && !part.image && !part.document)
      : (message.parts ?? []),
  )
}
