import type { ModelMessage, ModelPart, SessionMark } from "@merakcode/sdk"

export type Turn = {
  user?: ModelMessage
  /** The identifier the engine reverts to for this user message; missing when it cannot be reverted to */
  mark?: string
  replies: ModelMessage[]
}

/** Canonical messages are ordered; each user message starts the next turn. */
export function turns(messages: readonly ModelMessage[], marks?: readonly SessionMark[] | null) {
  const result: Turn[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      result.push({ user: message, mark: marks?.find((mark) => mark.index === index)?.id, replies: [] })
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

/** The parts of a message a person sees: what the engine added for the model (the date, recalled notes) stays hidden. */
export function visibleParts(message: ModelMessage): ModelPart[] {
  return (message.parts ?? []).filter((part) => !part.synthetic)
}
