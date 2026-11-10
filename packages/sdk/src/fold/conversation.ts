import type { EngineEvent, ModelChunk, ModelPart, SessionState, ToolCompletion, WindowReport } from "../protocol.gen"
import { foldSession } from "./session"

export type ToolView = {
  id: string
  name: string
  input: unknown
  status: "running" | "completed" | "error"
  parts: ModelPart[]
  startedAt?: string
  endedAt?: string
  result?: ToolCompletion
}

export type Conversation = {
  state: SessionState
  tools: Record<string, ToolView>
  live?: { parts: ModelPart[]; call?: string }
  permissions: Record<string, Extract<EngineEvent, { type: "permission.requested" }>>
  questions: Record<string, Extract<EngineEvent, { type: "question.asked" }>>
  budget?: WindowReport
  error?: string
}

/** Restores display data from the canonical snapshot without changing the snapshot. */
export function createConversation(state: SessionState): Conversation {
  const permissions: Conversation["permissions"] = {}
  for (const [id, pending] of Object.entries(state.permissions ?? {})) {
    if (pending.request.leader) continue
    permissions[id] = {
      id,
      type: "permission.requested",
      stream: `session:${state.id}`,
      scope: pending.scope,
      time: pending.time,
      seq: pending.seq,
      actor: { kind: "agent", id: pending.request.member },
      payload: pending.request,
    }
  }
  const tools: Conversation["tools"] = {}
  for (const message of state.messages ?? []) {
    for (const part of message.parts ?? []) {
      if (part.toolCall) {
        const call = part.toolCall
        tools[call.id] = { id: call.id, name: call.name, input: call.input, status: "running", parts: [] }
      }
      if (part.toolResult && tools[part.toolResult.callId]) {
        const result = part.toolResult
        tools[result.callId] = {
          ...tools[result.callId]!,
          status: result.isError ? "error" : "completed",
          parts: result.parts ?? [],
        }
      }
    }
  }
  return { state, tools, permissions, questions: {} }
}

/** Folds live display data alongside the durable, Go-compatible session state. */
export function foldConversation(previous: Conversation, event: EngineEvent): Conversation {
  if (event.scope.session !== previous.state.id) return previous
  if (event.seq && event.seq <= previous.state.lastSeq) {
    if (event.type === "message.completed" && previous.live) return { ...previous, live: undefined }
    return previous
  }
  const state = foldSession(previous.state, event)!
  const next = { ...previous, state }
  switch (event.type) {
    case "message.delta":
      next.live = collect(previous.live, event.payload)
      break
    case "message.completed":
      if (event.payload.parts?.length) delete next.live
      for (const part of event.payload.parts ?? []) {
        if (!part.toolCall) continue
        const call = part.toolCall
        next.tools = {
          ...next.tools,
          [call.id]: { id: call.id, name: call.name, input: call.input, status: "running", parts: [] },
        }
      }
      break
    case "tool.called": {
      const call = event.payload
      next.tools = {
        ...next.tools,
        [call.id]: {
          id: call.id,
          name: call.name,
          input: call.input,
          status: "running",
          parts: [],
          startedAt: event.time,
        },
      }
      break
    }
    case "tool.completed": {
      const result = event.payload
      next.tools = {
        ...next.tools,
        [result.callId]: {
          id: result.callId,
          name: result.name,
          input: previous.tools[result.callId]?.input,
          status: result.isError ? "error" : "completed",
          parts: result.parts ?? [],
          startedAt: previous.tools[result.callId]?.startedAt,
          endedAt: event.time,
          result,
        },
      }
      break
    }
    case "permission.requested":
      if (!event.payload.leader) next.permissions = { ...previous.permissions, [event.id]: event }
      break
    case "permission.escalated":
      if (event.cause) {
        next.permissions = {
          ...previous.permissions,
          [event.cause]: { ...event, id: event.cause, type: "permission.requested" },
        }
      }
      break
    case "permission.replied":
      next.permissions = { ...previous.permissions }
      if (event.cause) delete next.permissions[event.cause]
      break
    case "question.asked":
      next.questions = { ...previous.questions, [event.id]: event }
      break
    case "question.answered":
      next.questions = { ...previous.questions }
      if (event.cause) delete next.questions[event.cause]
      break
    case "session.budget":
      next.budget = event.payload
      break
    case "turn.started":
      delete next.error
      break
    case "turn.finished":
      delete next.live
      next.permissions = Object.fromEntries(
        Object.entries(previous.permissions).filter(([, request]) => request.payload.kind === "workspace"),
      )
      next.questions = {}
      next.error = event.payload.code
      break
  }
  return next
}

function collect(previous: Conversation["live"], chunk: ModelChunk): NonNullable<Conversation["live"]> {
  const live = structuredClone(previous ?? { parts: [] })
  const last = live.parts.at(-1)
  switch (chunk.kind) {
    case "text":
      if (last && !last.reasoning && !last.toolCall) last.text = (last.text ?? "") + (chunk.text ?? "")
      else live.parts.push({ text: chunk.text ?? "" })
      break
    case "reasoning":
      if (!chunk.reasoning) break
      if (last?.reasoning && !last.reasoning.opaque && last.reasoning.provider === chunk.reasoning.provider) {
        last.reasoning.text = (last.reasoning.text ?? "") + (chunk.reasoning.text ?? "")
        if (chunk.reasoning.opaque) last.reasoning.opaque = chunk.reasoning.opaque
      } else live.parts.push({ reasoning: structuredClone(chunk.reasoning) })
      break
    case "toolCallStart":
      if (!chunk.toolCall) break
      live.call = chunk.toolCall.id
      live.parts.push({ toolCall: { ...chunk.toolCall, input: chunk.toolCall.input ?? "" } })
      break
    case "toolCallDelta": {
      const id = chunk.toolCall?.id ?? live.call
      const call = live.parts.find((part) => part.toolCall?.id === id)?.toolCall
      if (call) call.input = String(call.input ?? "") + (chunk.text ?? "")
      break
    }
    case "toolCallEnd":
      delete live.call
      break
  }
  return live
}
