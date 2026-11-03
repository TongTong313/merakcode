import { Session } from "../session"
import { PermissionLevel } from "./level"
import { SessionStore } from "../session/store"

/** Synchronous lookup for live tool contexts, including tools released from pending approval. */
export function permissionLevelNow(sessionID: string, fallback = PermissionLevel.DEFAULT): PermissionLevel.Value {
  const visited = new Set<string>()
  let session = SessionStore.find(sessionID)
  while (session?.parentID && !visited.has(session.id)) {
    visited.add(session.id)
    session = SessionStore.find(session.parentID)
  }
  return session?.permissionLevel ?? fallback
}

export async function permissionLevelOf(
  session: Pick<Session.Info, "id" | "parentID" | "permissionLevel">,
  fallback?: PermissionLevel.Value,
): Promise<PermissionLevel.Value> {
  if (!session.parentID) return session.permissionLevel ?? fallback ?? PermissionLevel.DEFAULT
  const root = await Session.get(await Session.rootID(session.id)).catch(() => undefined)
  return root?.permissionLevel ?? PermissionLevel.DEFAULT
}
