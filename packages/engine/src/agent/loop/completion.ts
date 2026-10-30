import type { Session } from "../session"
import type { Message } from "../session/message"
import { MemoryExtract } from "../memory/extract"
import { SessionMemory } from "../memory/session-memory/session-memory"
import { AutoDream } from "../memory/dream/dream"

/** Starts follow-up memory work once, after an agent turn has a final assistant response. */
export function scheduleTurnCompletion(input: {
  session: Session.Info
  assistant: Message.AssistantInfo
  model: Message.UserInfo["model"]
  tokens: number
}) {
  const { session, assistant, model, tokens } = input
  MemoryExtract.schedule({ session, assistant, model })
  SessionMemory.schedule({ session, assistant, model, tokens })
  AutoDream.schedule({ session, assistant, model })
}
