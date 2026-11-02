import { Session } from "../session"
import { SessionMode } from "./mode"
import { SessionStore } from "../session/store"

/** Synchronous lookup for live tool contexts, including tools released from pending approval. */
export function sessionModeNow(sessionID: string, fallback = SessionMode.DEFAULT): SessionMode.Value {
  const visited = new Set<string>()
  let session = SessionStore.find(sessionID)
  while (session?.parentID && !visited.has(session.id)) {
    visited.add(session.id)
    session = SessionStore.find(session.parentID)
  }
  return session?.sessionMode ?? fallback
}

export async function sessionModeOf(
  session: Pick<Session.Info, "id" | "parentID" | "sessionMode">,
  fallback?: SessionMode.Value,
): Promise<SessionMode.Value> {
  if (!session.parentID) return session.sessionMode ?? fallback ?? SessionMode.DEFAULT
  const root = await Session.get(await Session.rootID(session.id)).catch(() => undefined)
  return root?.sessionMode ?? SessionMode.DEFAULT
}
