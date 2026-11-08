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
    case "session.rebuilt": {
      const rebuilt = event.payload
      if (rebuilt.from !== 0 || rebuilt.to <= 0 || rebuilt.to > (state.messages?.length ?? 0))
        throw new Error("Invalid rebuild range")
      const retained = state
        .messages!.slice(rebuilt.to)
        .map((message) => ({ ...message, parts: message.parts?.filter((part) => !part.reasoning) ?? [] }))
        .filter((message) => message.parts.length)
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
      state.status = event.payload.stop === "answered" ? "done" : event.payload.stop === "failed" ? "failed" : "idle"
      break
    case "message.sent":
    case "message.completed": {
      const { role, parts } = event.payload
      state.messages ??= []
      state.messages.push({ role, parts: structuredClone(parts) })
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
  if (!Object.keys(state.open!).length) delete state.open
  if (!Object.keys(state.causes!).length) delete state.causes
  state.lastSeq = event.seq
  return state
}
