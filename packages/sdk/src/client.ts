import { z } from "zod"
import metadata from "../package.json" with { type: "json" }
import { createApi } from "./api"
import {
  EngineEventSchema,
  PROTOCOL_VERSION,
  ProtocolErrorSchema,
  methodSchemas,
  type EngineEvent,
  type EventFilter,
  type Methods,
} from "./protocol.gen"

const optionsSchema = z.object({
  endpoint: z.url().refine((value) => new URL(value).protocol === "ws:", "Expected a local WebSocket endpoint"),
  token: z.string().min(1).optional(),
})
const messageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number().int(), z.string()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: ProtocolErrorSchema.optional(),
  params: z.unknown().optional(),
})

const ToolCallSchema = z.object({ call: z.string(), name: z.string(), input: z.unknown().optional() })

export type ClientToolDefinition = {
  name: string
  description: string
  schema?: unknown
  effect?: "read" | "write" | "exec" | "network"
}
export type ClientToolHandler = (
  input: unknown,
) => Promise<{ text: string; isError?: boolean }> | { text: string; isError?: boolean }

/** Calls that wait on a model service, an external product or a log archive get longer than the default 10 seconds. */
const CALL_TIMEOUTS: Partial<Record<keyof Methods, number>> = {
  "agent.test": 40000,
  "model.refresh": 30000,
  "model.discover": 30000,
  "remote.connect": 30000,
  "group.create": 30000,
  "session.compact": 60000,
  "session.revert": 30000,
  "session.unrevert": 30000,
  "session.delete": 30000,
  "worktree.create": 60000,
  "worktree.merge": 60000,
  "repo.push": 120000,
  "repo.commitMessage": 60000,
  "diagnostics.bundle": 120000,
}

export async function connect(options: {
  endpoint: string
  token?: string
  approve?: boolean
  client?: { name: string; version: string }
}) {
  const parsed = optionsSchema.parse(options)
  const NodeWebSocket = WebSocket as typeof WebSocket & {
    new (url: string, options: { headers: Record<string, string> }): WebSocket
  }
  const socket = parsed.token
    ? new NodeWebSocket(parsed.endpoint, { headers: { Authorization: `Bearer ${parsed.token}` } })
    : new WebSocket(parsed.endpoint)
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const listeners = new Map<(event: EngineEvent) => void, EventFilter>()
  const toolHandlers = new Map<string, ClientToolHandler>()
  let nextID = 0
  let failure: Error | undefined
  const closed = Promise.withResolvers<void>()
  const fail = (error: Error) => {
    failure = error
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  socket.addEventListener("close", () => {
    fail(new Error("MRK-1001"))
    closed.resolve()
  })
  socket.addEventListener("message", (event) => {
    try {
      if (typeof event.data !== "string") throw new Error("MRK-1001")
      const message = messageSchema.parse(JSON.parse(event.data))
      if (message.method === "event" || message.method === "events.lagged") {
        const fact = EngineEventSchema.parse(message.params)
        for (const [listener, filter] of listeners) {
          if (matches(filter, fact)) listener(fact)
        }
        return
      }
      if (message.method === "tool.call") {
        void runClientTool(ToolCallSchema.parse(message.params))
        return
      }
      if (typeof message.id !== "number") return
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.data.code))
      else request.resolve(message.result)
    } catch {
      fail(new Error("MRK-1001"))
      socket.close()
    }
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MRK-1001")), 10000)
      const finish = (error?: Error) => {
        clearTimeout(timer)
        socket.removeEventListener("error", onError)
        error ? reject(error) : resolve()
      }
      const onError = () => finish(new Error("MRK-1001"))
      socket.addEventListener("error", onError, { once: true })
      socket.addEventListener("open", () => finish(), { once: true })
    })
  } catch (error) {
    socket.close()
    throw error
  }
  socket.addEventListener("error", () => fail(new Error("MRK-1001")))

  async function call<K extends keyof Methods>(method: K, params: Methods[K]["params"]): Promise<Methods[K]["result"]> {
    if (failure) throw failure
    const input = methodSchemas[method].params.parse(params)
    const id = ++nextID
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error("MRK-1001"))
      }, CALL_TIMEOUTS[method] ?? 10000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: input }))
      } catch {
        pending.delete(id)
        clearTimeout(timer)
        reject(new Error("MRK-1001"))
      }
    })
    return methodSchemas[method].result.parse(result) as Methods[K]["result"]
  }

  async function runClientTool(request: { call: string; name: string; input?: unknown }) {
    const handler = toolHandlers.get(request.name)
    let result: { text: string; isError?: boolean }
    try {
      if (!handler) throw new Error("tool is not registered")
      result = await handler(request.input)
    } catch (error) {
      result = { text: error instanceof Error ? error.message : String(error), isError: true }
    }
    await call("tool.result", { call: request.call, text: result.text, isError: result.isError }).catch(() => {})
  }

  let hello: Methods["hello"]["result"]
  try {
    hello = await call("hello", {
      protocol: PROTOCOL_VERSION,
      client: options.client ?? { name: "sdk", version: metadata.version },
      capabilities: { approve: !!options.approve },
    })
    if (hello.protocol !== PROTOCOL_VERSION) throw new Error("MRK-1002")
  } catch (error) {
    socket.close()
    throw error
  }

  async function getBlob(ref: string): Promise<Uint8Array> {
    let output: Uint8Array | undefined
    let offset = 0
    for (;;) {
      const chunk = await call("blob.read", { ref, offset, limit: 1 << 20 })
      if (chunk.offset !== offset || chunk.total < 0 || chunk.total > 64 << 20) throw new Error("MRK-1003")
      output ??= new Uint8Array(chunk.total)
      if (chunk.total !== output.byteLength) throw new Error("MRK-1003")
      let data: Uint8Array
      try {
        data = Uint8Array.from(atob(chunk.data ?? ""), (character) => character.charCodeAt(0))
      } catch {
        throw new Error("MRK-1003")
      }
      if (offset + data.byteLength > output.byteLength || (data.byteLength === 0 && offset < output.byteLength))
        throw new Error("MRK-1003")
      output.set(data, offset)
      offset += data.byteLength
      if (offset === output.byteLength) return output
    }
  }

  const api = createApi(call)
  return {
    hello,
    closed: closed.promise,
    ...api,
    tool: {
      /** Offers a tool to the models as client__<name>; the handler runs here when a model calls it. */
      register: async (definition: ClientToolDefinition, handler: ClientToolHandler) => {
        toolHandlers.set(definition.name, handler)
        try {
          await call("tool.register", { ...definition, schema: definition.schema ?? { type: "object" } })
        } catch (error) {
          toolHandlers.delete(definition.name)
          throw error
        }
      },
      unregister: async (name: string) => {
        await call("tool.unregister", { name })
        toolHandlers.delete(name)
      },
    },
    blob: {
      ...api.blob,
      get: getBlob,
    },
    events: {
      ...api.events,
      subscribe: async (filter: EventFilter, listener: (event: EngineEvent) => void) => {
        listeners.set(listener, filter)
        let subscription: string
        try {
          subscription = (await call("events.subscribe", filter)).subscription
        } catch (error) {
          listeners.delete(listener)
          throw error
        }
        return async () => {
          listeners.delete(listener)
          await call("events.unsubscribe", { subscription })
        }
      },
    },
    close: async () => {
      socket.close()
      await closed.promise
    },
  }
}

function matches(filter: EventFilter, event: EngineEvent) {
  if (event.type === "events.lagged") return true
  return (
    (!filter.streams?.length || filter.streams.includes(event.stream)) &&
    (!filter.types?.length || filter.types.includes(event.type)) &&
    (!filter.scope?.group || filter.scope.group === event.scope.group) &&
    (!filter.scope?.task || filter.scope.task === event.scope.task) &&
    (!filter.scope?.session || filter.scope.session === event.scope.session) &&
    (!filter.scope?.turn || filter.scope.turn === event.scope.turn)
  )
}
