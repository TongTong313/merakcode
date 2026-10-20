/**
 * High-level API: start (or connect to) an engine, open sessions in it, run turns and read the results as an event
 * stream.
 *
 *   const merak = await createMerakCode({ cwd })
 *   const session = await merak.session()
 *   for await (const event of session.run("Fix the bug in math.js")) …
 *   await merak.close()
 */
import { createMerakCodeClient, type MerakCodeClient } from "../client/index.js"
import type {
  AgentConfig,
  AssistantMessageOutput,
  Event,
  MessageOutput,
  PartOutput,
  PermissionMode,
  PermissionRequest,
  QuestionRequest,
  SessionOutput,
} from "../client/gen/types.gen.js"
import { EngineExitedError, startEngine, type Engine, type EngineOptions } from "../process/index.js"
import { serveTools, type HostTool } from "./tool.js"
import { MerakCodeError, fromResponse } from "../errors.js"
import { ErrorCode } from "@merakcode/util/error-code"
import { parseModel } from "@merakcode/util/model"

export { tool, type HostTool, type ToolRunContext } from "./tool.js"

export type MerakCodeOptions = EngineOptions & {
  /** URL of an engine that is already running; no new engine process is started */
  url?: string
  /** Request headers (such as the password) to send when connecting to an existing engine */
  headers?: Record<string, string>
  /** Tools defined in the host process that the model can call (see tool()) */
  tools?: HostTool[]
  /** Custom agents, written like the agent section of the config file (only applies when starting an engine) */
  agents?: Record<string, AgentConfig>
  /** Your own run or trace id; the engine writes it into the log line of every request */
  clientRun?: string
}

/**
 * Events produced by a session. `text` is a streamed chunk of the reply; `reasoning` is a streamed chunk of the
 * model's thinking (only from models with thinking enabled; some put the conclusion only in the thinking and leave
 * the reply empty).
 */
export type RunEvent =
  | { type: "text"; partID: string; delta: string }
  | { type: "reasoning"; partID: string; delta: string }
  | { type: "part"; part: PartOutput }
  | { type: "done"; message: AssistantMessageOutput }
  | { type: "error"; error: MerakCodeError }

/** Answer to a permission request: allow once / allow for this session / always (saved to project config) / deny */
export type PermissionDecision = "allow-once" | "allow-session" | "always" | "deny"

export type Handlers = {
  /**
   * Called when the engine needs approval, including requests from subagents and workflows. Without a handler every
   * request is denied: nothing is allowed unless the host says so.
   */
  onPermission?: (request: PermissionRequest) => Promise<PermissionDecision> | PermissionDecision
  /**
   * Called when the model asks questions; return the selected options for each question in order (custom text is
   * allowed). Without a handler the questions are dismissed.
   */
  onQuestion?: (request: QuestionRequest) => Promise<string[][]> | string[][]
  /** Aborting stops the turn (including the work running in the engine) and the iteration throws AbortError */
  signal?: AbortSignal
}

export type RunOptions = Handlers & {
  agent?: string
  /** Model, written as "provider/model" */
  model?: string
  /** Permission mode: read-only / ask every time / automatic */
  mode?: PermissionMode
}

const replies = {
  "allow-once": "once",
  "allow-session": "session",
  always: "always",
  deny: "reject",
} as const

export type MerakCodeSession = {
  id: string
  info: SessionOutput
  /** Sends a message and yields the events of this turn, ending with `done` */
  run(prompt: string, options?: RunOptions): AsyncIterable<RunEvent>
  /**
   * All later events of this session, across turns. A background workflow posts another turn to the session when it
   * finishes; use this to keep waiting for its result. Yields `done` at the end of each turn and ends when the signal
   * aborts.
   */
  events(options?: Handlers): AsyncIterable<RunEvent>
  messages(): Promise<{ info: MessageOutput; parts: PartOutput[] }[]>
  /** Stops the current turn (queued messages still run) */
  abort(): Promise<void>
}

export type MerakCode = {
  /** The underlying generated client */
  client: MerakCodeClient
  url: string
  /** PID of the started engine; undefined when connected to an existing engine */
  pid: number | undefined
  /** Creates a session, or returns the existing session when an id is given */
  session(input?: { id?: string; title?: string; parentID?: string }): Promise<MerakCodeSession>
  close(): Promise<void>
}

function modelOf(model: string | undefined) {
  if (!model) return undefined
  if (model.indexOf("/") <= 0)
    throw new MerakCodeError({
      code: ErrorCode.CATALOG.BAD_REQUEST.code,
      message: `Write the model as provider/model: ${model}`,
    })
  return parseModel(model)
}

function sessionOf(event: Event): string | undefined {
  const properties = event.properties as {
    sessionID?: string
    info?: { sessionID?: string }
    part?: { sessionID?: string }
  }
  return properties.sessionID ?? properties.part?.sessionID ?? properties.info?.sessionID
}

function aborted(signal: AbortSignal) {
  return signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("This operation was aborted", "AbortError")
}

export async function createMerakCode(options: MerakCodeOptions = {}): Promise<MerakCode> {
  const config = options.agents ? { ...options.config, agent: options.agents } : options.config
  const engine: Engine | undefined = options.url ? undefined : await startEngine({ ...options, config })
  const url = options.url ?? engine!.url
  const headers = options.url ? options.headers : engine!.headers
  const client = createMerakCodeClient({
    baseUrl: url,
    headers,
    directory: options.cwd,
    clientRun: options.clientRun,
    logger: options.logger,
  })
  const stopTools = options.tools?.length ? await serveTools(client, options.tools) : undefined
  // If the engine exits unexpectedly, every iteration still waiting for events ends with EngineExitedError; an exit
  // caused by close() does not count
  let closed = false
  const crashed = engine
    ? engine.exited.then((code) =>
        closed ? new Promise<never>(() => {}) : Promise.reject(new EngineExitedError(code)),
      )
    : new Promise<never>(() => {})
  crashed.catch(() => undefined)

  /**
   * Subscribes to this session's events. Resolves only once the subscription is ready (server.connected), so a
   * message sent afterwards cannot lose its first events. With once, the stream ends after the first turn.
   */
  async function subscribe(sessionID: string, handlers: Handlers, once: boolean) {
    const abort = new AbortController()
    const stop = () => abort.abort()
    handlers.signal?.addEventListener("abort", stop, { once: true })
    const events = await client.event.subscribe(undefined, { signal: abort.signal })
    const iterator = events.stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done || (first.value as Event).type !== "server.connected") {
      abort.abort()
      throw new MerakCodeError({
        code: ErrorCode.CATALOG.EVENT_STREAM_LOST.code,
        message: "Could not connect to the engine's event stream",
      })
    }
    // Permission requests and questions from this session and its child sessions (subagents, workflows)
    const ours = (request: { sessionID: string; root?: string }) =>
      request.sessionID === sessionID || request.root === sessionID
    const permit = async (request: PermissionRequest) => {
      const decision = handlers.onPermission ? await handlers.onPermission(request) : "deny"
      await client.permission.reply({ requestID: request.id, reply: replies[decision] })
    }
    const answer = async (request: QuestionRequest) => {
      if (!handlers.onQuestion) return void (await client.question.reject({ requestID: request.id }))
      await client.question.reply({ requestID: request.id, answers: await handlers.onQuestion(request) })
    }

    async function* stream(): AsyncGenerator<RunEvent> {
      try {
        for (;;) {
          const next = await Promise.race([iterator.next(), crashed]).catch((error: unknown) => {
            if (error instanceof EngineExitedError) throw error
            if (abort.signal.aborted) return { done: true as const, value: undefined }
            throw error
          })
          if (next.done) break
          const event = next.value as Event
          if (event.type === "permission.asked" && ours(event.properties)) {
            void permit(event.properties)
            continue
          }
          if (event.type === "question.asked" && ours(event.properties)) {
            void answer(event.properties)
            continue
          }
          if (sessionOf(event) !== sessionID) continue
          if (event.type === "message.part.updated") {
            const { part, delta } = event.properties
            if (delta !== undefined && (part.type === "text" || part.type === "reasoning"))
              yield { type: part.type, partID: part.id, delta }
            else yield { type: "part", part }
            continue
          }
          if (event.type === "session.error") {
            yield { type: "error", error: fromResponse(event.properties.error) }
            continue
          }
          if (event.type === "session.idle") {
            const messages = await client.session.messages({ sessionID })
            const last = [...(messages.data ?? [])].reverse().find((message) => message.info.role === "assistant")
            if (last) yield { type: "done", message: last.info as AssistantMessageOutput }
            if (once) return
          }
        }
        if (handlers.signal?.aborted && once) {
          await client.session.abort({ sessionID }).catch(() => undefined)
          throw aborted(handlers.signal)
        }
      } finally {
        handlers.signal?.removeEventListener("abort", stop)
        abort.abort()
      }
    }
    return stream()
  }

  function wrap(info: SessionOutput): MerakCodeSession {
    return {
      id: info.id,
      info,
      async *run(prompt, input = {}) {
        input.signal?.throwIfAborted()
        const stream = await subscribe(info.id, input, true)
        const sent = await client.session.promptAsync({
          sessionID: info.id,
          agent: input.agent,
          model: modelOf(input.model),
          permissionMode: input.mode,
          parts: [{ type: "text", text: prompt }],
        })
        if (sent.error) {
          await stream.return(undefined)
          throw fromResponse(sent.error, sent.response)
        }
        yield* stream
      },
      async *events(input = {}) {
        yield* await subscribe(info.id, input, false)
      },
      async messages() {
        const result = await client.session.messages({ sessionID: info.id })
        if (!result.data) throw fromResponse(result.error, result.response)
        return result.data
      },
      async abort() {
        await client.session.abort({ sessionID: info.id })
      },
    }
  }

  return {
    client,
    url,
    pid: engine?.pid,
    async session(input = {}) {
      const { id, ...create } = input
      const result = id ? await client.session.get({ sessionID: id }) : await client.session.create(create)
      if (!result.data) throw fromResponse(result.error, result.response)
      return wrap(result.data)
    },
    close: async () => {
      closed = true
      await stopTools?.()
      await engine?.close()
    },
  }
}
