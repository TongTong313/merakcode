/**
 * Starts the engine process (`merak serve`) and manages its lifetime. Node only.
 *
 * - Finding the engine: `executablePath`, else the platform package `merakcode-<os>-<arch>` (shared by the SDK and
 *   the CLI)
 * - Random port and a one-time password: the password reaches the engine only through an environment variable and
 *   the SDK uses it for requests
 * - Started with an IPC channel: when the host exits or crashes the channel closes and the engine shuts itself down
 *   (this is what works on Windows, where SIGTERM cannot be sent)
 */
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { ErrorCode } from "@merakcode/util/error-code"
import { MerakCodeError } from "../errors.js"
import type { Logger } from "../logger.js"

export type EngineOptions = {
  /** Project directory, used as the engine process's working directory */
  cwd?: string
  /**
   * Engine command: an executable path or a full command prefix (such as
   * `[node, "--import", loader, "apps/cli/src/index.ts"]`). Defaults to the engine in the platform package.
   */
  executablePath?: string | string[]
  /** Extra environment variables for the engine process */
  env?: Record<string, string | undefined>
  /** Inline config, equivalent to the project's merakcode.json (highest priority) */
  config?: Record<string, unknown>
  /** Maximum time in milliseconds to wait for the engine to start listening */
  timeout?: number
  /** Arguments for `serve`; by default it listens only on a random local port (`--hostname 127.0.0.1 --port 0`) */
  serve?: string[]
  signal?: AbortSignal
  /** Called when the engine starts, listens, fails to start and exits */
  logger?: Logger
}

export type Engine = {
  /** Engine URL, e.g. http://127.0.0.1:53124 */
  url: string
  /** Request headers for accessing the engine (Basic password) */
  headers: Record<string, string>
  pid: number
  /** Resolves when the engine process exits: 0 after a normal shutdown, otherwise the exit code or signal */
  exited: Promise<number | null>
  /** Asks the engine to shut down and waits for it to exit; kills it after a timeout */
  close(): Promise<void>
}

/** The engine did not start; `output` holds the engine's last output, the message its last five lines */
export class EngineStartError extends MerakCodeError {
  constructor(
    message: string,
    readonly output: string,
    code: string = ErrorCode.CATALOG.ENGINE_START_FAILED.code,
  ) {
    super({ code, message: output.trim() ? `${message}\n${output.trim().split("\n").slice(-5).join("\n")}` : message })
    this.name = "EngineStartError"
  }
}

/** The engine process exited while in use (crashed or was killed) */
export class EngineExitedError extends MerakCodeError {
  constructor(readonly exitCode: number | null) {
    super({
      code: ErrorCode.CATALOG.ENGINE_EXITED.code,
      message: `The engine process exited unexpectedly (${exitCode})`,
    })
    this.name = "EngineExitedError"
  }
}

const LISTENING = /listening on (https?:\/\/\S+)/

/** Platform package name; Windows is spelled windows, matching the CLI release script */
function platformPackage(platform = process.platform, arch = process.arch) {
  return `merakcode-${platform === "win32" ? "windows" : platform}-${arch}`
}

/** Engine command from the platform package: its bundled Node running lib/index.js */
export function resolveEngine(from = import.meta.url): string[] {
  const name = platformPackage()
  const manifest = (() => {
    try {
      return createRequire(from).resolve(`${name}/package.json`)
    } catch {
      return undefined
    }
  })()
  if (!manifest)
    throw new MerakCodeError({
      code: ErrorCode.CATALOG.ENGINE_NOT_FOUND.code,
      message: `The engine package ${name} is not installed. Reinstall @merakcode/sdk, or pass executablePath.`,
    })
  const root = path.dirname(manifest)
  const node = path.join(root, "node", process.platform === "win32" ? "node.exe" : path.join("bin", "node"))
  const entry = path.join(root, "lib", "index.js")
  if (!existsSync(node) || !existsSync(entry))
    throw new MerakCodeError({
      code: ErrorCode.CATALOG.ENGINE_NOT_FOUND.code,
      message: `The engine package ${name} is incomplete: ${existsSync(node) ? entry : node} is missing`,
    })
  return [node, "--disable-warning=ExperimentalWarning", entry]
}

function command(executable: EngineOptions["executablePath"]): string[] {
  if (Array.isArray(executable)) return executable
  if (executable) return [executable]
  return resolveEngine()
}

export async function startEngine(options: EngineOptions = {}): Promise<Engine> {
  const [file, ...prefix] = command(options.executablePath)
  const password = randomBytes(24).toString("base64url")
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...options.env }))
    if (value !== undefined) env[key] = value
  Object.assign(env, {
    MERAKCODE_SERVER_USERNAME: "merakcode",
    MERAKCODE_SERVER_PASSWORD: password,
    // Terminal and management endpoints only accept requests from this process tree (see the engine's
    // auth/local-guard.ts)
    MERAKCODE_SERVER_PARENT_PID: String(process.pid),
    MERAKCODE_CLIENT: env.MERAKCODE_CLIENT ?? "sdk",
    ...(options.config ? { MERAKCODE_CONFIG_CONTENT: JSON.stringify(options.config) } : {}),
  })
  const serve = options.serve ?? ["--hostname", "127.0.0.1", "--port", "0"]
  const log = options.logger ?? (() => {})
  log({
    level: "info",
    message: "engine starting",
    data: { command: [file, ...prefix, "serve", ...serve], cwd: options.cwd },
  })
  const child = spawn(file!, [...prefix, "serve", ...serve], {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  })
  let closing: Promise<void> | undefined
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : null))),
  )
  void exited.then((code) =>
    log({ level: closing || code === 0 ? "info" : "error", message: "engine exited", data: { code, pid: child.pid } }),
  )
  let output = ""
  const collect = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-8000))
  child.stderr!.on("data", collect)

  const url = await new Promise<string>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(
      () =>
        fail(
          new EngineStartError(
            "The engine took too long to start",
            output,
            ErrorCode.CATALOG.ENGINE_START_TIMEOUT.code,
          ),
        ),
      options.timeout ?? 60_000,
    )
    const abort = () =>
      fail(new EngineStartError("Starting the engine was cancelled", output, ErrorCode.CATALOG.ABORTED.code))
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      log({
        level: "error",
        message: "engine failed to start",
        data: { code: (error as MerakCodeError).code, output: output.slice(-2000) },
      })
      void stop(child, exited)
      reject(error)
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    child.stdout!.on("data", (chunk: Buffer) => {
      collect(chunk)
      const match = output.match(LISTENING)
      if (!match || settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      // When listening on all interfaces (0.0.0.0 / ::), connect through loopback
      resolve(match[1]!.replace(/\/\/(0\.0\.0\.0|\[::\])(?=:)/, "//127.0.0.1"))
    })
    child.once("error", (error) => fail(new EngineStartError(`The engine could not start: ${error.message}`, output)))
    void exited.then((code) =>
      fail(new EngineStartError(`The engine exited before it started listening (${code})`, output)),
    )
  })

  log({ level: "info", message: "engine listening", data: { url, pid: child.pid } })
  return {
    url,
    headers: { authorization: `Basic ${Buffer.from(`merakcode:${password}`).toString("base64")}` },
    pid: child.pid!,
    exited,
    close: () => (closing ??= stop(child, exited)),
  }
}

/** Disconnects the channel so the engine shuts itself down (see the CLI's shutdown.ts); kills it if that times out */
async function stop(child: ChildProcess, exited: Promise<unknown>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (child.connected) child.disconnect()
  const timeout = setTimeout(() => child.kill(), 8_000)
  await exited
  clearTimeout(timeout)
}
