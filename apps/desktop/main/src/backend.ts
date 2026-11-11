import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { connect, PROTOCOL_VERSION } from "@merakcode/sdk"
import metadata from "../package.json" with { type: "json" }

/**
 * Connects to the local Go engine, the daemon of the user, and starts it when it is not running. The engine is its own
 * process and outlives the app: closing the app only closes the connection, and only `shutdown` stops the engine.
 * The main process keeps the token for authenticated window requests.
 */
export type Endpoint = { url: string; origin: string; port: number; headers: Record<string, string> }
export type State = "starting" | "ready" | "restarting" | "failed" | "stopped"

export type Options = {
  /** Engine command prefix (see engine.ts), followed by `serve` */
  executable: string[]
  /** Read on every start and added on top of the current environment */
  env: () => Record<string, string | undefined>
  cwd: string
  log: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void
  /** Maximum wait for the backend to start listening */
  timeout?: number
  /** Delays between consecutive restarts; once used up, stays in failed until the user retries */
  delays?: number[]
  /** After running this long without problems, the restart count resets */
  stable?: number
  /** Additional serve flags, including a scripted model for integration tests */
  serve?: string[]
}

type Client = Awaited<ReturnType<typeof connect>>
type Running = { client: Client; pid: number; disconnect: () => Promise<void>; stopEngine: () => Promise<void> }
const connectionSchema = z.object({
  endpoint: z.url().refine((url) => /^ws:\/\/127\.0\.0\.1:\d+\/rpc$/.test(url)),
  token: z.string().min(1),
  pid: z.number().int().positive(),
  protocol: z.literal(PROTOCOL_VERSION),
})

/** The engine keeps its connection file and database in <root>/data; the root is MERAKCODE_HOME or ~/.merakcode. */
function dataDirectory(env: NodeJS.ProcessEnv) {
  return path.join(env.MERAKCODE_HOME || path.join(homedir(), ".merakcode"), "data")
}

function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function kill(pid: number) {
  try {
    process.kill(pid)
  } catch {
    /* The engine may have already exited. */
  }
}

export class Backend extends EventEmitter<{ state: [State, Endpoint | undefined]; exit: [number | null] }> {
  state: State = "stopped"
  endpoint?: Endpoint
  /** Why the last start failed, including the last lines of child output; cleared on success, shown in the UI */
  error?: string
  private engine?: Running
  get client() {
    return this.engine?.client
  }
  private port = 0
  private attempt = 0
  private stopping = false
  private timer?: NodeJS.Timeout
  private ready?: number
  /** The launch in progress: a restart or stop waits for it, so two engines never start on one port */
  private launching?: Promise<unknown>
  private restarting?: Promise<Endpoint>
  private again?: Promise<Endpoint>

  constructor(private options: Options) {
    super()
  }

  /** Starts the backend and waits until it listens. Returns the current endpoint if it is already running */
  async start(): Promise<Endpoint> {
    if (this.state === "ready" && this.endpoint) return this.endpoint
    this.stopping = false
    this.set("starting")
    return this.first()
  }

  /**
   * Manual restart (Retry in the UI, or Help › Restart Local Service): resets the restart count and starts
   * again once any start in progress is done. Requests made while restarting merge into one more restart.
   */
  restart(): Promise<Endpoint> {
    if (this.again) return this.again
    if (this.restarting) {
      this.again = this.restarting
        .catch(() => undefined)
        .then(() => {
          this.again = undefined
          return this.restart()
        })
      return this.again
    }
    const run = this.relaunch()
    this.restarting = run
    void run
      .catch(() => undefined)
      .finally(() => {
        if (this.restarting === run) this.restarting = undefined
      })
    return run
  }

  private async relaunch() {
    clearTimeout(this.timer)
    await this.launching
    await this.kill()
    this.attempt = 0
    this.stopping = false
    this.set("starting")
    return this.first()
  }

  /** A failed first start (or manual retry) is rarely transient, so no automatic retry; stays in failed */
  private first() {
    return this.launch().catch((error: Error) => {
      if (!this.stopping) this.set("failed")
      throw error
    })
  }

  /** Closes the connection and leaves the engine running; this is what quitting the app does. */
  async stop() {
    this.stopping = true
    clearTimeout(this.timer)
    await this.launching
    await this.release()
    this.set("stopped")
  }

  /** Stops the engine itself and closes the connection ("Stop background engine and quit", `merak stop`). */
  async shutdown() {
    this.stopping = true
    clearTimeout(this.timer)
    await this.launching
    await this.kill()
    this.set("stopped")
  }

  private set(state: State) {
    this.state = state
    this.emit("state", state, state === "ready" ? this.endpoint : undefined)
  }

  private launch() {
    const run = this.spawn()
    this.launching = run.catch(() => undefined)
    return run
  }

  private async spawn(): Promise<Endpoint> {
    this.options.log("info", "backend starting", { port: this.port, attempt: this.attempt })
    const env = { ...process.env, ...this.options.env() }
    const home = dataDirectory(env)
    await mkdir(home, { recursive: true })
    let child: ChildProcess | undefined
    let childExit: Promise<number | null> | undefined
    let childError: Error | undefined
    let info: z.infer<typeof connectionSchema> | undefined
    const attach = async () => {
      try {
        info = connectionSchema.parse(JSON.parse(await readFile(path.join(home, "engine.json"), "utf8")))
        return await connect({ ...info, client: { name: "desktop", version: metadata.version } })
      } catch {
        return undefined
      }
    }
    let client: Client | undefined
    try {
      client = await attach()
      if (!client) {
        const [command, ...prefix] = this.options.executable
        if (!command) throw new Error("MRK-1001")
        // Detached, so that the engine is not a child of the app that started it and goes on when the app quits
        child = spawn(command, [...prefix, "serve", "--port", String(this.port), ...(this.options.serve ?? [])], {
          cwd: this.options.cwd,
          env,
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        })
        childExit = new Promise((resolve) => {
          child!.once("error", (error) => {
            childError = error
            resolve(null)
          })
          child!.once("exit", resolve)
        })
        child.unref()
        const deadline = Date.now() + (this.options.timeout ?? 10000)
        while (!client && Date.now() < deadline) {
          if (childError) throw childError
          if (child.exitCode !== null || child.signalCode !== null) throw new Error("MRK-1001")
          client = await attach()
          if (!client) await delay(25)
        }
      }
      if (!client || !info) throw new Error("MRK-1001")
    } catch (error) {
      child?.kill()
      await childExit
      this.options.log("error", "backend start failed", { code: "MRK-1001" })
      this.error = "MRK-1001"
      throw error
    }
    const connected = client
    const pid = info.pid
    let stopping: Promise<void> | undefined
    const engine: Running = {
      client: connected,
      pid,
      disconnect: () => connected.close(),
      stopEngine: () =>
        (stopping ??= (async () => {
          let timer: NodeJS.Timeout | undefined
          const graceful = connected.engine
            .stop()
            .then(() => connected.closed)
            .then(
              () => true,
              () => false,
            )
          const finished = await Promise.race([
            graceful,
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), 10000)
            }),
          ])
          clearTimeout(timer)
          if (!finished) kill(pid)
          await connected.close()
          // The files of the engine are free only when its process is gone
          for (let wait = 0; wait < 200 && running(pid); wait++) await delay(25)
          if (running(pid)) kill(pid)
        })()),
    }
    this.engine = engine
    void connected.closed
      .then(() => this.exited(engine, null))
      .catch((error: Error) => {
        this.error = error.message
      })
    const address = new URL(info.endpoint)
    const { origin, port } = new URL(`http://${address.host}`)
    this.port = Number(port)
    this.endpoint = { url: origin, origin, port: Number(port), headers: { authorization: `Bearer ${info.token}` } }
    this.error = undefined
    this.ready = Date.now()
    this.set("ready")
    this.options.log("info", "backend ready", { port: this.endpoint.port })
    return this.endpoint
  }

  private exited(engine: Running, code: number | null) {
    this.emit("exit", code)
    // Deliberate stops (stop, manual restart) are not unexpected exits
    if (this.engine !== engine) return
    this.engine = undefined
    if (this.stopping) return
    this.options.log("warn", "backend exited", { code })
    if (this.ready && Date.now() - this.ready > (this.options.stable ?? 60_000)) this.attempt = 0
    this.retry()
  }

  private retry() {
    const delays = this.options.delays ?? [500, 1_000, 2_000, 5_000, 10_000]
    if (this.attempt >= delays.length) {
      this.set("failed")
      return
    }
    this.set("restarting")
    this.timer = setTimeout(() => {
      this.attempt++
      this.launch().catch(() => !this.stopping && this.retry())
    }, delays[this.attempt])
  }

  /** Stops the engine and closes the connection to it. */
  private async kill() {
    const engine = this.engine
    this.engine = undefined
    await engine?.stopEngine()
  }

  /** Closes the connection and leaves the engine running. */
  private async release() {
    const engine = this.engine
    this.engine = undefined
    await engine?.disconnect()
  }
}
