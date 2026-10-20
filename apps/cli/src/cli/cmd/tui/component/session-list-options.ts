export interface SessionListOptionSession {
  id: string
  title: string
  parentID?: string
  time: {
    updated: number
  }
}

export interface SessionListOption {
  title: string
  value: string
  category: string
  updated: number
}

export function buildSessionListOptions(input: {
  sessions: SessionListOptionSession[]
  pinnedIds: string[]
  today: string
  todayLabel: string
  pinnedSectionLabel: string
}): SessionListOption[] {
  const roots = input.sessions
    .filter((session) => session.parentID === undefined)
    .toSorted((a, b) => b.time.updated - a.time.updated)
  const sessions = new Map(roots.map((session) => [session.id, session]))
  const pinned = [...new Set(input.pinnedIds)].filter((id) => sessions.has(id))
  const pinnedSet = new Set(pinned)

  function option(session: SessionListOptionSession, category: string): SessionListOption {
    return {
      title: session.title,
      value: session.id,
      category,
      updated: session.time.updated,
    }
  }

  function category(session: SessionListOptionSession) {
    const date = new Date(session.time.updated).toDateString()
    return date === input.today ? input.todayLabel : date
  }

  return [
    ...pinned.map((id) => option(sessions.get(id)!, input.pinnedSectionLabel)),
    ...roots.filter((session) => !pinnedSet.has(session.id)).map((session) => option(session, category(session))),
  ]
}
