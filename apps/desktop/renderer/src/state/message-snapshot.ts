import type { Event, SessionMessagesResponses } from "@merakcode/sdk/client"
import { applyEvent, type SessionsState } from "@merakcode/sdk/store"

/** Only entities untouched since the request began may be filled from its history response. */
export class MessageSnapshot {
  private messages = new Set<string>()
  private parts = new Set<string>()
  private removed = new Set<string>()
  private deleted = false

  constructor(private sessionID: string) {}

  observe(event: Event) {
    switch (event.type) {
      case "message.updated":
        if (event.properties.info.sessionID === this.sessionID) this.messages.add(event.properties.info.id)
        return
      case "message.removed":
        if (event.properties.sessionID !== this.sessionID) return
        this.messages.add(event.properties.messageID)
        this.removed.add(event.properties.messageID)
        return
      case "message.part.updated":
        if (event.properties.part.sessionID === this.sessionID) this.parts.add(event.properties.part.id)
        return
      case "message.part.removed":
        if (event.properties.sessionID === this.sessionID) this.parts.add(event.properties.partID)
        return
      case "session.deleted":
      case "session.updated":
        if (
          event.properties.info.id === this.sessionID &&
          (event.type === "session.deleted" || event.properties.info.time.archived)
        )
          this.deleted = true
    }
  }

  apply(state: SessionsState, history: SessionMessagesResponses[200]) {
    if (this.deleted) return false
    for (const item of history) {
      if (this.removed.has(item.info.id)) continue
      if (!this.messages.has(item.info.id))
        applyEvent(state, { type: "message.updated", properties: { sessionID: this.sessionID, info: item.info } })
      for (const part of item.parts)
        if (!this.parts.has(part.id)) applyEvent(state, { type: "message.part.updated", properties: { part } })
    }
    return true
  }
}
