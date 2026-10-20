import type { ModelMessage } from "ai"
import type { Provider } from "../provider/provider"
import { Message } from "./message"

export namespace SessionContextLayer {
  export type ProjectInput = {
    messages: Message.FullMsg[]
    excludeMessageID?: string
  }

  export type ModelMessagesInput = ProjectInput & {
    model: Provider.Model
  }

  export type Projection = {
    baseSummary?: string
    deltaMessages: Message.FullMsg[]
  }

  export function sortByTurnCausality<T extends { info: { role: string; id: string; parentID?: string } }>(
    messages: T[],
  ): T[] {
    const result: T[] = []
    const userTurns: T[] = []
    const turnMap = new Map<string, T[]>()

    for (const m of messages) {
      if (m.info.role === "user") {
        userTurns.push(m)
        turnMap.set(m.info.id, [])
      } else if (m.info.role === "assistant" && m.info.parentID && turnMap.has(m.info.parentID)) {
        turnMap.get(m.info.parentID)!.push(m)
      } else {
        result.push(m)
      }
    }

    const flattened: T[] = []
    for (const u of userTurns) {
      flattened.push(u)
      const assistants = turnMap.get(u.info.id)
      if (assistants) {
        flattened.push(...assistants)
      }
    }
    return [...result, ...flattened]
  }

  export function project(input: ProjectInput): Projection {
    const source = input.messages.filter((msg) => msg.info.id !== input.excludeMessageID && !isCompactionControl(msg))
    const base = findBaseSummary(source)
    if (!base) return { deltaMessages: sortByTurnCausality(source) }

    return {
      baseSummary: base.summary,
      deltaMessages: sortByTurnCausality(source.slice(base.index + 1)),
    }
  }

  export async function toModelMessages(input: ModelMessagesInput): Promise<ModelMessage[]> {
    const projected = project(input)
    return [
      ...(projected.baseSummary ? [toBaseSummaryMessage(projected.baseSummary)] : []),
      ...(await Message.toModelMessages(projected.deltaMessages, input.model)),
    ]
  }

  export function toBaseSummaryMessage(summary: string): ModelMessage {
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "<compaction-base>",
            "Previous conversation summary. It condenses older messages that are no longer shown verbatim.",
            "Use it as background context. Newer messages below supersede it if there is a conflict.",
            "",
            summary,
            "</compaction-base>",
          ].join("\n"),
        },
      ],
    }
  }

  function findBaseSummary(messages: Message.FullMsg[]) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info.role !== "assistant" || !msg.info.summary || !msg.info.finish) continue
      const summary = summaryText(msg)
      if (!summary) continue
      return { index: i, summary }
    }
  }

  function isCompactionControl(msg: Message.FullMsg) {
    return msg.info.role === "user" && msg.parts.length > 0 && msg.parts.every((part) => part.type === "compaction")
  }

  function summaryText(msg: Message.FullMsg) {
    return msg.parts
      .filter((part): part is Message.TextPart => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n")
  }
}
