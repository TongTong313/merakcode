export type SessionDeleteAction =
  | {
      type: "pending"
      sessionID: string
    }
  | {
      type: "delete"
      sessionID: string
    }

export function moveSessionDelete(pending: string | undefined, selected: string) {
  if (pending === selected) return pending
  return undefined
}

export function retainSessionDelete(pending: string | undefined, sessionIDs: string[]) {
  if (pending && sessionIDs.includes(pending)) return pending
  return undefined
}

export function triggerSessionDelete(pending: string | undefined, selected: string): SessionDeleteAction {
  if (pending === selected) return { type: "delete", sessionID: selected }
  return { type: "pending", sessionID: selected }
}

export function nextSessionAfterDelete(sessionIDs: string[], sessionID: string) {
  const index = sessionIDs.indexOf(sessionID)
  if (index === -1) return undefined
  return sessionIDs[index + 1] ?? sessionIDs[index - 1]
}

export function sessionRouteAfterDelete(
  currentSessionID: string | undefined,
  deletedSessionID: string,
  visibleSessionIDs: string[],
) {
  if (currentSessionID !== deletedSessionID) return undefined
  const next = nextSessionAfterDelete(visibleSessionIDs, deletedSessionID)
  if (next) return { type: "session" as const, sessionID: next }
  return { type: "home" as const }
}

export function removeSessionTree<T extends { id: string; parentID?: string }>(sessions: T[], sessionID: string) {
  const removed = new Set([sessionID])
  const pending = [sessionID]

  while (pending.length > 0) {
    const parentID = pending.pop()!
    sessions
      .filter((session) => session.parentID === parentID && !removed.has(session.id))
      .forEach((session) => {
        removed.add(session.id)
        pending.push(session.id)
      })
  }

  return sessions.filter((session) => !removed.has(session.id))
}
