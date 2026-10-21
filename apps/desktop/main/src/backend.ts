import { EventEmitter } from "node:events"
import { startEngine, type Engine } from "@merakcode/sdk/process"
import { Network } from "@merakcode/util/network"

/**
 * Lifecycle of the local backend (the engine's `serve` child process): started through the SDK, awaited until it
 * listens, and restarted after an unexpected exit.
 *
 * - Listens on 127.0.0.1 only, on a port picked here. Restarts reuse the same port so open windows keep their address
 *   and the UI event stream simply reconnects. Only when the port is taken is a new one picked, and windows reload.
 * - Each start gets a new random token from the SDK. It stays in the main process, which adds it to window requests
 *   (see auth.ts).
 * - The SDK starts the backend over an IPC channel: when the main process exits or crashes, the channel closes and the
 *   backend shuts itself down, so no orphan process is left behind.
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
}

export class Backend extends EventEmitter<{ state: [State, Endpoint | undefined]; exit: [number | null] }> {
  state: State = "stopped"
  endpoint?: Endpoint
  /** Why the last start failed, including the last lines of child output; cleared on success, shown in the UI */
  error?: string
  private engine?: Engine
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
   * Manual restart (Retry in the UI, or changed engine sources in development): resets the restart count and starts
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

  async stop() {
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
    if (!this.port) this.port = await Network.freePort()
    this.options.log("info", "backend starting", { port: this.port, attempt: this.attempt })
    const engine = await startEngine({
      cwd: this.options.cwd,
      executablePath: this.options.executable,
      env: { ...this.options.env(), MERAKCODE_CLIENT: "desktop" },
      serve: ["--hostname", "127.0.0.1", "--port", String(this.port)],
      timeout: this.options.timeout,
    }).catch((error: Error) => {
      this.options.log("error", "backend start failed", { error: error.message })
      this.error = error.message
      // Another program may have taken the port: pick a new one next time
      this.port = 0
      throw error
    })
    this.engine = engine
    void engine.exited.then((code) => this.exited(engine, code))
    const { origin, port } = new URL(engine.url)
    this.endpoint = { url: origin, origin, port: Number(port), headers: engine.headers }
    this.error = undefined
    this.ready = Date.now()
    this.set("ready")
    this.options.log("info", "backend ready", { port: this.endpoint.port })
    return this.endpoint
  }

  private exited(engine: Engine, code: number | null) {
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

  /** Closes the channel so the backend can shut down, then kills it if it does not (SDK close) */
  private async kill() {
    const engine = this.engine
    this.engine = undefined
    await engine?.close()
  }
}
