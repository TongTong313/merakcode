import type { EngineEvent, ModelPart, ModelUsage, SessionState } from "../protocol.gen"
import { ToolSpecSchema } from "../protocol.gen"

const emptyUsage = (): ModelUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false })

function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  if (
    b.input === 0 &&
    b.output === 0 &&
    b.cacheRead === 0 &&
    b.cacheWrite === 0 &&
    b.cost === 0 &&
    !b.costKnown &&
    !b.currency
  )
    return { ...a }
  const result = { ...b }
  if (a.input + a.output + a.cacheRead + a.cacheWrite > 0) {
    result.costKnown = a.costKnown && b.costKnown && a.currency === b.currency
    if (a.currency !== b.currency) delete result.currency
  }
  result.input += a.input
  result.output += a.output
  result.cacheRead += a.cacheRead
  result.cacheWrite += a.cacheWrite
  result.cost = result.costKnown ? a.cost + b.cost : 0
  return result
}

/** Folds durable events into the same state as Go session.Fold. Replayed duplicates are ignored. */
export function foldSession(previous: SessionState | undefined, event: EngineEvent): SessionState | undefined {
  if (!event.seq || (previous && event.seq <= previous.lastSeq)) return previous
  if (previous && event.scope.session !== previous.id) return previous
  if (event.seq !== (previous?.lastSeq ?? 0) + 1) throw new Error("Session event sequence gap")
  if (event.type === "session.created") {
    const created = structuredClone(event.payload)
    return {
      ...created,
      status: created.status || "idle",
      scope: { ...created.scope, session: created.id },
      lastSeq: event.seq,
    }
  }
  if (!previous) throw new Error("Missing session.created")
  const state: SessionState = {
    ...previous,
    scope: { ...previous.scope },
    messages: previous.messages?.map((message) => ({ ...message, parts: message.parts?.slice() ?? null })) ?? null,
    open: { ...previous.open },
    causes: { ...previous.causes },
  }
  switch (event.type) {
    case "session.budget_extended":
      state.budgetExtensions = (previous.budgetExtensions ?? 0) + 1
      break
    case "session.warning":
      if (
        !(previous.warnings ?? []).some(
          (warning) => warning.code === event.payload.code && warning.server === event.payload.server,
        )
      ) {
        state.warnings = [...(previous.warnings ?? []).slice(-63), event.payload]
      }
      break
    case "session.mcp_configured":
      state.mcp = structuredClone(event.payload)
      break
    case "permission.requested":
      state.permissions = {
        ...previous.permissions,
        [event.id]: {
          request: { ...event.payload, id: event.id },
          scope: { ...event.scope },
          time: event.time,
          seq: event.seq,
        },
      }
      break
    case "permission.escalated": {
      const pending = event.cause ? previous.permissions?.[event.cause] : undefined
      if (event.cause && pending) {
        state.permissions = {
          ...previous.permissions,
          [event.cause]: { ...pending, request: { ...pending.request, leader: undefined } },
        }
      }
      break
    }
    case "permission.replied":
      state.permissions = { ...previous.permissions }
      if (event.cause) delete state.permissions[event.cause]
      if (!Object.keys(state.permissions).length) delete state.permissions
      break
    case "child.started":
    case "child.finished": {
      const child = event.payload
      const delivered = previous.children?.[child.id]?.delivered ?? false
      state.children = {
        ...previous.children,
        [child.id]: { id: child.id, delivered: delivered || event.type === "child.finished" },
      }
      if (event.type === "child.finished" && !delivered) {
        state.messages ??= []
        state.messages.push({
          role: "user",
          parts: [{ text: `Child ${child.id} report (${child.stop ?? ""}):` }, ...structuredClone(child.report ?? [])],
        })
      }
      break
    }
    case "memory.extracted":
      state.usage = addUsage(state.usage, event.payload.usage)
      break
    case "session.budget":
      state.usage = addUsage(state.usage, event.payload.summaryUsage ?? emptyUsage())
      break
    case "snapshot.tracked":
      state.tracks = [...(previous.tracks ?? []), { index: state.messages?.length ?? 0, tree: event.payload.tree }]
      break
    case "session.reverted": {
      const mark = previous.marks?.find((candidate) => candidate.id === event.payload.message)
      const total = state.messages?.length ?? 0
      if (!mark || mark.index > total) throw new Error("Revert target is not a message of the session")
      const hiddenMarks = (previous.marks ?? []).filter((candidate) => candidate.index >= mark.index)
      const hiddenTracks = (previous.tracks ?? []).filter((candidate) => candidate.index > mark.index)
      state.hidden = {
        index: mark.index,
        messages: structuredClone(state.messages!.slice(mark.index)),
        ...(hiddenMarks.length ? { marks: hiddenMarks } : {}),
        ...(hiddenTracks.length ? { tracks: hiddenTracks } : {}),
        ...(event.payload.current ? { current: event.payload.current } : {}),
      }
      state.messages = state.messages!.slice(0, mark.index)
      state.marks = (previous.marks ?? []).slice(0, (previous.marks?.length ?? 0) - hiddenMarks.length)
      state.tracks = (previous.tracks ?? []).slice(0, (previous.tracks?.length ?? 0) - hiddenTracks.length)
      break
    }
    case "session.unreverted":
      if (!previous.hidden) throw new Error("Nothing was reverted")
      state.messages = [...(state.messages ?? []), ...(previous.hidden.messages ?? [])]
      state.marks = [...(previous.marks ?? []), ...(previous.hidden.marks ?? [])]
      state.tracks = [...(previous.tracks ?? []), ...(previous.hidden.tracks ?? [])]
      delete state.hidden
      break
    case "session.updated":
      if (event.payload.title != null) state.title = event.payload.title
      if (event.payload.archived != null) state.archived = event.payload.archived
      if (event.payload.mode) state.config = { ...state.config, mode: event.payload.mode }
      break
    case "todo.updated":
      state.todos = structuredClone(event.payload.items ?? [])
      break
    case "session.rebuilt": {
      const rebuilt = event.payload
      if (rebuilt.from !== 0 || rebuilt.to <= 0 || rebuilt.to > (state.messages?.length ?? 0))
        throw new Error("Invalid rebuild range")
      const retained = state
        .messages!.slice(rebuilt.to)
        .map((message) => ({ ...message, parts: message.parts?.filter((part) => !part.reasoning) ?? [] }))
        .filter((message) => message.parts.length)
      state.marks = (previous.marks ?? [])
        .filter((mark) => mark.index >= rebuilt.to)
        .map((mark) => ({ id: mark.id, index: mark.index - rebuilt.to + 1 }))
      state.tracks = (previous.tracks ?? [])
        .filter((track) => track.index > rebuilt.to)
        .map((track) => ({ index: track.index - rebuilt.to + 1, tree: track.tree }))
      state.messages = [structuredClone(rebuilt.summary), ...retained]
      state.summaryId = rebuilt.summaryId
      state.usage = addUsage(state.usage, rebuilt.usage)
      break
    }
    case "turn.started":
      if (event.payload.selection) {
        state.config = { ...state.config, ...event.payload.selection }
        if (!event.payload.selection.thinking) delete state.config.thinking
      }
      state.scope = { ...event.scope, turn: event.id }
      state.status = "running"
      break
    case "turn.finished":
      state.permissions = Object.fromEntries(
        Object.entries(previous.permissions ?? {}).filter(([, pending]) => pending.request.kind === "workspace"),
      )
      if (!Object.keys(state.permissions).length) delete state.permissions
      state.status = event.payload.stop === "answered" ? "done" : event.payload.stop === "failed" ? "failed" : "idle"
      break
    case "message.sent":
    case "message.completed": {
      const { role, parts } = event.payload
      state.messages ??= []
      if (parts?.length) {
        if (event.type === "message.sent" && role === "user") {
          delete state.hidden
          state.marks = [...(previous.marks ?? []), { id: event.id, index: state.messages.length }]
        }
        state.messages.push({ role, parts: structuredClone(parts) })
      }
      state.usage = addUsage(state.usage, event.type === "message.completed" ? event.payload.usage : emptyUsage())
      for (const part of parts ?? []) if (part.toolCall) state.open![part.toolCall.id] = part.toolCall
      break
    }
    case "tool.called":
      state.open![event.payload.id] = event.payload
      state.causes![event.payload.id] = event.id
      break
    case "tool.completed": {
      delete state.open![event.payload.callId]
      delete state.causes![event.payload.callId]
      if (event.payload.name === "load_tools" && !event.payload.isError) {
        const loaded = new Set(state.loaded ?? [])
        for (const part of event.payload.parts ?? []) {
          if (part.text) for (const spec of ToolSpecSchema.array().parse(JSON.parse(part.text))) loaded.add(spec.name)
        }
        if (loaded.size) state.loaded = [...loaded]
      }
      const part: ModelPart = {
        toolResult: {
          callId: event.payload.callId,
          parts: structuredClone(event.payload.parts),
          ...(event.payload.isError ? { isError: true } : {}),
        },
      }
      state.messages ??= []
      const last = state.messages.at(-1)
      if (last?.role === "tool") (last.parts ??= []).push(part)
      else state.messages.push({ role: "tool", parts: [part] })
      break
    }
  }
  if (!state.marks?.length) delete state.marks
  if (!state.tracks?.length) delete state.tracks
  if (!Object.keys(state.open!).length) delete state.open
  if (!Object.keys(state.causes!).length) delete state.causes
  state.lastSeq = event.seq
  return state
}
