/**
 * Reduces engine events to session state. Not tied to any UI framework: it mutates the given state object in place.
 *
 * - Plain object: applyEvent(state, event)
 * - Solid: setStore(produce((draft) => applyEvent(draft, event)))
 *
 * Every list is sorted by id (engine ids increase over time) and searched with binary search. Updates merge in place:
 * unchanged child objects keep their references, so UI frameworks only re-render what changed.
 */
import type {
  Event,
  FileDiff,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
  VcsInfo,
} from "../client/gen/types.gen.js"

export type SessionsState = {
  session: Session[]
  session_status: Record<string, SessionStatus>
  session_diff: Record<string, FileDiff[]>
  todo: Record<string, Todo[]>
  permission: Record<string, PermissionRequest[]>
  question: Record<string, QuestionRequest[]>
  /** Session id → messages sorted by id */
  message: Record<string, Message[]>
  /** Message id → parts sorted by id */
  part: Record<string, Part[]>
  vcs: VcsInfo | undefined
}

export function createSessionsState(): SessionsState {
  return {
    session: [],
    session_status: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    message: {},
    part: {},
    vcs: undefined,
  }
}

/** What applyEvent did: insert / update / remove refer to the session, message, part, permission or question lists */
export type Change = "insert" | "update" | "remove" | "replace" | "none" | "ignored"

/** Binary search: when found, index is the item's position; otherwise it is where the item would be inserted */
export function search<T>(list: readonly T[], id: string, key: (item: T) => string) {
  let low = 0
  let high = list.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const value = key(list[mid]!)
    if (value === id) return { found: true, index: mid }
    if (value < id) low = mid + 1
    else high = mid - 1
  }
  return { found: false, index: low }
}

/** Merges next into target in place: equal child objects keep their references, keys missing from next are removed */
function merge(target: Record<string, unknown>, next: Record<string, unknown>) {
  for (const key of Object.keys(target)) if (!(key in next)) delete target[key]
  for (const [key, value] of Object.entries(next)) {
    const current = target[key]
    if (current === value) continue
    if (plain(current) && plain(value)) {
      merge(current, value)
      continue
    }
    if (Array.isArray(current) && Array.isArray(value) && JSON.stringify(current) === JSON.stringify(value)) continue
    target[key] = value
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const id = (item: { id: string }) => item.id

function upsert<T extends { id: string }>(list: T[], item: T): Change {
  const result = search(list, item.id, id)
  if (!result.found) {
    list.splice(result.index, 0, item)
    return "insert"
  }
  merge(list[result.index] as Record<string, unknown>, item as Record<string, unknown>)
  return "update"
}

function remove<T extends { id: string }>(list: T[] | undefined, key: string): Change {
  if (!list) return "none"
  const result = search(list, key, id)
  if (!result.found) return "none"
  list.splice(result.index, 1)
  return "remove"
}

function bucket<T>(map: Record<string, T[]>, key: string) {
  return (map[key] ??= [])
}

/** Removes everything cached for a session (messages, parts, permissions, questions, todos, diffs, status) */
export function forgetSession(state: SessionsState, sessionID: string) {
  for (const item of state.message[sessionID] ?? []) delete state.part[item.id]
  delete state.message[sessionID]
  delete state.session_diff[sessionID]
  delete state.todo[sessionID]
  delete state.permission[sessionID]
  delete state.question[sessionID]
  delete state.session_status[sessionID]
}

export function applyEvent(state: SessionsState, event: Event): Change {
  switch (event.type) {
    case "session.created":
    case "session.updated": {
      const info = event.properties.info as Session
      if (info.time.archived) {
        const change = remove(state.session, info.id)
        forgetSession(state, info.id)
        return change
      }
      return upsert(state.session, info)
    }
    case "session.deleted": {
      const info = event.properties.info as Session
      const change = remove(state.session, info.id)
      forgetSession(state, info.id)
      return change
    }
    case "session.status":
      state.session_status[event.properties.sessionID] = event.properties.status as SessionStatus
      return "replace"
    case "session.diff":
      state.session_diff[event.properties.sessionID] = event.properties.diff as FileDiff[]
      return "replace"
    case "todo.updated":
      state.todo[event.properties.sessionID] = event.properties.todos as Todo[]
      return "replace"
    case "message.updated": {
      const info = event.properties.info as Message
      return upsert(bucket(state.message, info.sessionID), info)
    }
    case "message.removed": {
      const change = remove(state.message[event.properties.sessionID], event.properties.messageID)
      delete state.part[event.properties.messageID]
      return change
    }
    case "message.part.updated": {
      const part = event.properties.part as Part
      return upsert(bucket(state.part, part.messageID), part)
    }
    case "message.part.removed": {
      const parts = state.part[event.properties.messageID]
      const change = remove(parts, event.properties.partID)
      if (parts?.length === 0) delete state.part[event.properties.messageID]
      return change
    }
    case "permission.asked": {
      const request = event.properties as PermissionRequest
      return upsert(bucket(state.permission, request.sessionID), request)
    }
    case "permission.replied":
      return remove(state.permission[event.properties.sessionID], event.properties.requestID)
    case "question.asked": {
      const request = event.properties as QuestionRequest
      return upsert(bucket(state.question, request.sessionID), request)
    }
    case "question.replied":
    case "question.rejected":
      return remove(state.question[event.properties.sessionID], event.properties.requestID)
    case "vcs.branch.updated": {
      const branch = event.properties.branch
      // There is no branch name outside a git repository or with a detached HEAD
      if (state.vcs?.branch === branch) return "none"
      state.vcs = branch === undefined ? undefined : { branch }
      return "replace"
    }
  }
  return "ignored"
}

/**
 * Id of the root session of the conversation a session belongs to, following parentID upward; a session missing from
 * the list counts as its own root
 */
export function rootOf(state: SessionsState, sessionID: string) {
  let current = sessionID
  for (let depth = 0; depth < 64; depth++) {
    const found = search(state.session, current, id)
    const parent = found.found ? state.session[found.index]!.parentID : undefined
    if (!parent) return current
    current = parent
  }
  return current
}

/** Status of a conversation in the sidebar */
export type Activity = "approval" | "question" | "running" | "idle"

/**
 * Awaiting approval > awaiting an answer > running > idle. Permissions, questions and activity of child sessions
 * (subagents, workflows) count toward the root conversation.
 */
export function activity(state: SessionsState, sessionID: string): Activity {
  const ours = (request: { sessionID: string; root?: string }) =>
    (request.root ?? rootOf(state, request.sessionID)) === sessionID
  if (Object.values(state.permission).some((list) => list.some(ours))) return "approval"
  if (Object.values(state.question).some((list) => list.some(ours))) return "question"
  const running = Object.entries(state.session_status).some(
    ([key, status]) => status.type !== "idle" && rootOf(state, key) === sessionID,
  )
  return running ? "running" : "idle"
}
