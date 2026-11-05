import { AsyncLocalStorage } from "node:async_hooks"
import { BusEvent } from "../../infra/bus/bus-event"
import { Bus } from "../../infra/bus"
import { NativePty } from "../../infra/process/pty"
import z from "zod"
import { Identifier } from "@merakcode/util/id"
import { Log } from "@merakcode/log/logger"
import { Instance } from "../../infra/project/instance"
import { Shell } from "../../infra/process/shell/shell"
import { Plugin } from "../../agent/plugin"
import { ChildEnv } from "@merakcode/util/child-env"
import { Session } from "../../agent/session"
import { Lock } from "../../infra/concurrency/lock"
import { NamedError } from "@merakcode/util/error"
import { Text } from "../../agent/prompt/text"

export namespace Pty {
  const StopError = NamedError.create("TerminalStopError", z.object({ message: z.string() }))
  const ClosedError = NamedError.create("TerminalClosedError", z.object({ message: z.string() }))
  export const Owner = z
    .object({ sessionID: Identifier.schema("session").optional(), tabID: z.string().min(1) })
    .meta({ ref: "PtyOwner" })
  const closedTabs = Instance.state(() => new Set<string>())
  const log = Log.create({ service: "pty" })

  const BUFFER_LIMIT = 1024 * 1024 * 2
  const BUFFER_CHUNK = 64 * 1024
  const encoder = new TextEncoder()

  type Socket = {
    readyState: number
    send: (data: string | Uint8Array<ArrayBuffer> | ArrayBuffer) => void
    close: (code?: number, reason?: string) => void
  }

  const sockets = new WeakMap<object, number>()
  let socketCounter = 0

  const tagSocket = (ws: Socket) => {
    if (!ws || typeof ws !== "object") return
    const next = (socketCounter = (socketCounter + 1) % Number.MAX_SAFE_INTEGER)
    sockets.set(ws, next)
    return next
  }

  // WebSocket control frame: 0x00 + UTF-8 JSON (currently { cursor }).
  const meta = (cursor: number) => {
    const json = JSON.stringify({ cursor })
    const bytes = encoder.encode(json)
    const out = new Uint8Array(bytes.length + 1)
    out[0] = 0
    out.set(bytes, 1)
    return out
  }

  export const Info = z
    .object({
      id: Identifier.schema("pty"),
      title: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      status: z.enum(["running", "exited"]),
      pid: z.number(),
      owner: Owner.optional(),
    })
    .meta({ ref: "Pty" })

  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    owner: Owner.optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    title: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    size: z
      .object({
        cols: z.number().int().positive(),
        rows: z.number().int().positive(),
      })
      .optional(),
  })

  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z.object({
    owner: Owner.optional(),
    title: z.string().optional(),
    size: z
      .object({
        rows: z.number(),
        cols: z.number(),
      })
      .optional(),
  })

  export type UpdateInput = z.infer<typeof UpdateInput>

  export const Event = {
    Created: BusEvent.define("pty.created", z.object({ info: Info })),
    Updated: BusEvent.define("pty.updated", z.object({ info: Info })),
    Exited: BusEvent.define("pty.exited", z.object({ id: Identifier.schema("pty"), exitCode: z.number() })),
    Deleted: BusEvent.define("pty.deleted", z.object({ id: Identifier.schema("pty") })),
  }

  interface ActiveSession {
    info: Info
    process: NativePty.Process
    buffer: string
    bufferCursor: number
    cursor: number
    subscribers: Map<Socket, number>
    closing?: Promise<void>
    lease?: ReturnType<typeof setTimeout>
    releaseOwner?: () => void
  }

  // A conversation may move into a worktree after its terminal has already started in the original instance.
  const owned = new Map<string, Set<() => Promise<void>>>()
  function bindOwner(session: ActiveSession) {
    session.releaseOwner?.()
    session.releaseOwner = undefined
    const id = session.info.owner?.sessionID
    if (!id) return
    const terminals = owned.get(id) ?? new Set<() => Promise<void>>()
    const within = AsyncLocalStorage.snapshot()
    const stop = () =>
      within(async () => {
        if (session.info.owner?.sessionID === id) await remove(session.info.id)
      })
    terminals.add(stop)
    owned.set(id, terminals)
    session.releaseOwner = () => {
      terminals.delete(stop)
      if (!terminals.size && owned.get(id) === terminals) owned.delete(id)
    }
  }

  const state = Instance.state(
    () => new Map<string, ActiveSession>(),
    async (sessions) => {
      for (const session of sessions.values()) {
        clearTimeout(session.lease)
        try {
          await session.process.stop()
        } catch {}
        session.releaseOwner?.()
        for (const ws of session.subscribers.keys()) {
          try {
            ws.close()
          } catch {
            // ignore
          }
        }
      }
      sessions.clear()
    },
  )

  export function list() {
    return Array.from(state().values()).map((s) => s.info)
  }

  export function get(id: string) {
    return state().get(id)?.info
  }

  export async function create(input: CreateInput) {
    using _ = input.owner?.sessionID ? await Lock.read(`terminal-owner:${input.owner.sessionID}`) : undefined
    using _tab = input.owner ? await Lock.write(`terminal-tab:${input.owner.tabID}`) : undefined
    if (input.owner?.sessionID) await Session.get(input.owner.sessionID)
    if (input.owner && closedTabs().has(input.owner.tabID))
      throw new ClosedError({ message: await Text.pick({ zh: "终端标签已关闭", en: "The terminal tab is closed" }) })
    if (input.owner) {
      const existing = list().find((session) => session.owner?.tabID === input.owner!.tabID)
      if (existing) return existing
    }
    const id = Identifier.create("pty", false)
    const command = input.command || Shell.preferred()
    const args = input.args || []
    if (command.endsWith("sh")) {
      args.push("-l")
    }

    const cwd = input.cwd || Instance.directory
    const shellEnv = await Plugin.trigger("shell.env", { cwd }, { env: {} })
    const env = ChildEnv.build({
      extra: { ...input.env, ...shellEnv.env, TERM: "xterm-256color", MERAKCODE_TERMINAL: "1" },
    })

    if (process.platform === "win32") {
      env.LC_ALL = "C.UTF-8"
      env.LC_CTYPE = "C.UTF-8"
      env.LANG = "C.UTF-8"
    }
    const cols = input.size?.cols
    const rows = input.size?.rows
    log.info("creating session", { id, cmd: command, args, cwd, cols, rows })

    const ptyProcess = await NativePty.spawn(command, args, {
      name: "xterm-256color",
      cwd,
      env,
      ...(typeof cols === "number" && typeof rows === "number" ? { cols, rows } : {}),
    })

    const info = {
      id,
      title: input.title || `Terminal ${id.slice(-4)}`,
      command,
      args,
      cwd,
      status: "running",
      pid: ptyProcess.pid,
      ...(input.owner ? { owner: input.owner } : {}),
    } as const
    const session: ActiveSession = {
      info,
      process: ptyProcess,
      buffer: "",
      bufferCursor: 0,
      cursor: 0,
      subscribers: new Map(),
    }
    state().set(id, session)
    bindOwner(session)
    touch(session)
    ptyProcess.onData((data) => {
      session.cursor += data.length

      for (const [ws, id] of session.subscribers) {
        if (ws.readyState !== 1) {
          session.subscribers.delete(ws)
          continue
        }
        if (typeof ws === "object" && sockets.get(ws) !== id) {
          session.subscribers.delete(ws)
          continue
        }
        try {
          ws.send(data)
        } catch {
          session.subscribers.delete(ws)
        }
      }

      session.buffer += data
      if (session.buffer.length <= BUFFER_LIMIT) return
      const excess = session.buffer.length - BUFFER_LIMIT
      session.buffer = session.buffer.slice(excess)
      session.bufferCursor += excess
    })
    // On Linux the native exit callback can arrive without the instance context, and a throw there is uncaught
    const within = AsyncLocalStorage.snapshot()
    ptyProcess.onExit(({ exitCode }) =>
      within(() => {
        log.info("session exited", { id, exitCode })
        session.info.status = "exited"
        for (const ws of session.subscribers.keys()) {
          try {
            ws.close()
          } catch {
            // ignore
          }
        }
        session.subscribers.clear()
        void remove(id)
          .then(() => Bus.publish(Event.Exited, { id, exitCode }))
          .catch((error) => {
            log.warn("terminal cleanup failed", { id, error })
          })
      }),
    )
    Bus.publish(Event.Created, { info })
    return info
  }

  export async function update(id: string, input: UpdateInput) {
    const session = state().get(id)
    if (!session) return
    if (session.closing) {
      await session.closing
      return
    }
    if (input.owner) {
      using _owner = input.owner.sessionID ? await Lock.read(`terminal-owner:${input.owner.sessionID}`) : undefined
      using _tab = await Lock.write(`terminal-tab:${input.owner.tabID}`)
      if (input.owner.sessionID) await Session.get(input.owner.sessionID)
      if (state().get(id) !== session) return
      if (session.closing) {
        await session.closing
        return
      }
      if (closedTabs().has(input.owner.tabID)) {
        await remove(id)
        throw new ClosedError({ message: await Text.pick({ zh: "终端标签已关闭", en: "The terminal tab is closed" }) })
      }
      session.info.owner = input.owner
      bindOwner(session)
    }
    touch(session)
    if (input.title) {
      session.info.title = input.title
    }
    if (input.size) {
      session.process.resize(input.size.cols, input.size.rows)
    }
    Bus.publish(Event.Updated, { info: session.info })
    return session.info
  }

  export async function remove(id: string) {
    const session = state().get(id)
    if (!session) return
    if (session.closing) return session.closing
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void Text.pick({ zh: "无法确认终端进程已停止", en: "Could not confirm the terminal processes stopped" }).then(
          (message) => reject(new StopError({ message })),
        )
      }, 10_000)
      timer.unref()
    })
    session.closing = Promise.race([terminate(session), timeout])
      .catch((error) => {
        session.closing = undefined
        throw error
      })
      .finally(() => clearTimeout(timer))
    return session.closing
  }

  function touch(session: ActiveSession) {
    if (!session.info.owner) return
    clearTimeout(session.lease)
    const within = AsyncLocalStorage.snapshot()
    session.lease = setTimeout(
      () =>
        within(() => {
          void remove(session.info.id).catch((error) =>
            log.error("terminal lease cleanup failed", { id: session.info.id, error }),
          )
        }),
      90_000,
    )
    session.lease.unref()
  }

  export async function removeBySession(sessionID: string) {
    for (const stop of [...(owned.get(sessionID) ?? [])]) await stop()
  }

  export async function closeOwned(owner: z.infer<typeof Owner>) {
    using _ = await Lock.write(`terminal-tab:${owner.tabID}`)
    closedTabs().add(owner.tabID)
    for (const session of state().values()) if (session.info.owner?.tabID === owner.tabID) await remove(session.info.id)
  }

  async function terminate(session: ActiveSession) {
    const id = session.info.id
    log.info("removing session", { id })
    await session.process.stop()
    session.releaseOwner?.()
    clearTimeout(session.lease)
    for (const ws of session.subscribers.keys()) {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
    session.subscribers.clear()
    state().delete(id)
    Bus.publish(Event.Deleted, { id })
  }

  export function resize(id: string, cols: number, rows: number) {
    const session = state().get(id)
    if (session && session.info.status === "running") {
      session.process.resize(cols, rows)
    }
  }

  export function write(id: string, data: string) {
    const session = state().get(id)
    if (session && session.info.status === "running") {
      session.process.write(data)
    }
  }

  export function connect(id: string, ws: Socket, cursor?: number) {
    const session = state().get(id)
    if (!session) {
      ws.close()
      return
    }
    log.info("client connected to session", { id })

    const start = session.bufferCursor
    const end = session.cursor

    const from =
      cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0

    const data = (() => {
      if (!session.buffer) return ""
      if (from >= end) return ""
      const offset = Math.max(0, from - start)
      if (offset >= session.buffer.length) return ""
      return session.buffer.slice(offset)
    })()

    if (data) {
      try {
        for (let i = 0; i < data.length; i += BUFFER_CHUNK) {
          ws.send(data.slice(i, i + BUFFER_CHUNK))
        }
      } catch {
        ws.close()
        return
      }
    }

    try {
      ws.send(meta(end))
    } catch {
      ws.close()
      return
    }

    const socketId = tagSocket(ws)
    if (typeof socketId === "number") session.subscribers.set(ws, socketId)
    return {
      onMessage: (message: string | ArrayBuffer) => {
        session.process.write(String(message))
      },
      onClose: () => {
        log.info("client disconnected from session", { id })
        session.subscribers.delete(ws)
      },
    }
  }
}
