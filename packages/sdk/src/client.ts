import { z } from "zod"
import metadata from "../package.json" with { type: "json" }
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

/** Calls that wait on a model service, an external product or a log archive get longer than the default 10 seconds. */
const CALL_TIMEOUTS: Partial<Record<keyof Methods, number>> = {
  "agent.test": 40000,
  "model.refresh": 30000,
  "model.discover": 30000,
  "remote.connect": 30000,
  "group.create": 30000,
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

  return {
    hello,
    closed: closed.promise,
    cloud: {
      members: () => call("cloud.members", {}),
      status: () => call("cloud.status", {}),
      login: (params: Methods["cloud.login"]["params"]) => call("cloud.login", params),
      logout: () => call("cloud.logout", {}),
    },
    remote: {
      connect: (params: Methods["remote.connect"]["params"]) => call("remote.connect", params),
      members: () => call("remote.members", {}),
    },
    config: {
      get: () => call("config.get", {}),
      set: (params: Methods["config.set"]["params"]) => call("config.set", params),
    },
    model: {
      list: () => call("model.list", {}),
      refresh: (params: Methods["model.refresh"]["params"] = {}) => call("model.refresh", params),
      discover: (params: Methods["model.discover"]["params"]) => call("model.discover", params),
    },
    sandbox: {
      setup: () => call("sandbox.setup", {}),
      status: (params: Methods["sandbox.status"]["params"]) => call("sandbox.status", params),
    },
    agent: {
      catalog: () => call("agent.catalog", {}),
      delete: (params: Methods["agent.delete"]["params"]) => call("agent.delete", params),
      list: (params: Methods["agent.list"]["params"] = {}) => call("agent.list", params),
      save: (params: Methods["agent.save"]["params"]) => call("agent.save", params),
      test: (params: Methods["agent.test"]["params"]) => call("agent.test", params),
    },
    group: {
      pause: (params: Methods["group.pause"]["params"]) => call("group.pause", params),
      resume: (params: Methods["group.resume"]["params"]) => call("group.resume", params),
      removeMember: (params: Methods["group.removeMember"]["params"]) => call("group.removeMember", params),
      update: (params: Methods["group.update"]["params"]) => call("group.update", params),
      say: (params: Methods["group.say"]["params"]) => call("group.say", params),
      create: (params: Methods["group.create"]["params"]) => call("group.create", params),
      addMember: (params: Methods["group.addMember"]["params"]) => call("group.addMember", params),
      state: (params: Methods["group.state"]["params"]) => call("group.state", params),
      bind: (params: Methods["group.bind"]["params"]) => call("group.bind", params),
      list: () => call("group.list", {}),
    },
    task: {
      update: (params: Methods["task.update"]["params"]) => call("task.update", params),
      cancel: (params: Methods["task.cancel"]["params"]) => call("task.cancel", params),
      assign: (params: Methods["task.assign"]["params"]) => call("task.assign", params),
      review: (params: Methods["task.review"]["params"]) => call("task.review", params),
      create: (params: Methods["task.create"]["params"]) => call("task.create", params),
      list: (params: Methods["task.list"]["params"] = {}) => call("task.list", params),
      archive: (params: Methods["task.archive"]["params"]) => call("task.archive", params),
    },
    doc: {
      list: (params: Methods["doc.list"]["params"]) => call("doc.list", params),
      read: (params: Methods["doc.read"]["params"]) => call("doc.read", params),
      write: (params: Methods["doc.write"]["params"]) => call("doc.write", params),
    },
    permission: {
      reply: (params: Methods["permission.reply"]["params"]) => call("permission.reply", params),
    },
    question: {
      reply: (params: Methods["question.reply"]["params"]) => call("question.reply", params),
    },
    engine: {
      stop: () => call("engine.stop", {}),
    },
    diagnostics: {
      bundle: (params: Methods["diagnostics.bundle"]["params"] = {}) => call("diagnostics.bundle", params),
    },
    blob: {
      read: (params: Methods["blob.read"]["params"]) => call("blob.read", params),
      get: getBlob,
    },
    terminal: {
      list: (params: Methods["terminal.list"]["params"] = {}) => call("terminal.list", params),
      create: (params: Methods["terminal.create"]["params"]) => call("terminal.create", params),
      get: (params: Methods["terminal.get"]["params"]) => call("terminal.get", params),
      update: (params: Methods["terminal.update"]["params"]) => call("terminal.update", params),
      remove: (params: Methods["terminal.remove"]["params"]) => call("terminal.remove", params),
    },
    file: {
      read: (params: Methods["file.read"]["params"]) => call("file.read", params),
      list: (params: Methods["file.list"]["params"]) => call("file.list", params),
    },
    repo: {
      status: (params: Methods["repo.status"]["params"]) => call("repo.status", params),
      diff: (params: Methods["repo.diff"]["params"]) => call("repo.diff", params),
      branches: (params: Methods["repo.branches"]["params"]) => call("repo.branches", params),
      checkout: (params: Methods["repo.checkout"]["params"]) => call("repo.checkout", params),
    },
    session: {
      snapshot: (params: Methods["session.snapshot"]["params"]) => call("session.snapshot", params),
      list: () => call("session.list", {}),
      create: (params: Methods["session.create"]["params"]) => call("session.create", params),
      send: (params: Methods["session.send"]["params"]) => call("session.send", params),
      cancel: (params: Methods["session.cancel"]["params"]) => call("session.cancel", params),
    },
    event: {
      emit: (params: Methods["event.emit"]["params"]) => call("event.emit", params),
    },
    events: {
      read: (params: Methods["events.read"]["params"]) => call("events.read", params),
      find: (params: Methods["events.find"]["params"]) => call("events.find", params),
      get: (params: Methods["events.get"]["params"]) => call("events.get", params),
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
