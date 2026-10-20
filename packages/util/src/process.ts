import { constants, platform } from "node:os"
import { statSync, accessSync, constants as fsConstants } from "node:fs"
import path from "node:path"
import type { Readable, Writable } from "node:stream"
import spawnChild from "cross-spawn"

/**
 * Child processes:
 * - stdout is piped by default (web ReadableStream), stderr is inherited, stdin is ignored
 * - a missing command throws ENOENT synchronously
 * - when killed by a signal the exit code is 128 + signal number, like a shell
 * - on Windows, cross-spawn handles PATHEXT and escaping for .cmd/.bat
 */
export namespace Process {
  type Stdio = "pipe" | "ignore" | "inherit"

  export type SpawnOptions = {
    cwd?: string
    env?: NodeJS.ProcessEnv
    stdin?: Stdio
    stdout?: Stdio
    stderr?: Stdio
    /** Kills the child when aborted */
    signal?: AbortSignal
    /** Kills the child after this many milliseconds */
    timeout?: number
    /** Hide the console window on Windows; defaults to true */
    windowsHide?: boolean
  }

  export type Child = {
    readonly pid: number | undefined
    readonly stdin: Writable | null
    readonly stdout: ReadableStream<Uint8Array> | null
    readonly stderr: ReadableStream<Uint8Array> | null
    /** Resolves with the exit code when the child exits */
    readonly exited: Promise<number>
    /** null while the child is still running */
    readonly exitCode: number | null
    kill(signal?: NodeJS.Signals): void
  }

  export function spawn(cmd: string[], options: SpawnOptions = {}): Child {
    const [command, ...args] = cmd
    if (!command) throw new Error("Process.spawn: empty command")
    if (!which(command, { cwd: options.cwd, PATH: options.env?.PATH ?? options.env?.Path })) {
      throw Object.assign(new Error(`Executable not found: ${command}`), { code: "ENOENT", path: command })
    }
    const child = spawnChild(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin ?? "ignore", options.stdout ?? "pipe", options.stderr ?? "inherit"],
      windowsHide: options.windowsHide ?? true,
    })
    let exitCode: number | null = null
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => {
        exitCode = code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)
        resolve(exitCode)
      })
    })
    const kill = (signal?: NodeJS.Signals) => {
      if (exitCode === null) child.kill(signal)
    }
    if (options.signal) {
      if (options.signal.aborted) kill()
      else options.signal.addEventListener("abort", () => kill(), { once: true })
    }
    if (options.timeout) {
      const timer = setTimeout(() => kill(), options.timeout)
      void exited.finally(() => clearTimeout(timer)).catch(() => {})
    }
    const web = (stream: Readable | null) => (stream ? drain(stream) : null)
    return {
      pid: child.pid,
      stdin: child.stdin,
      stdout: web(child.stdout),
      stderr: web(child.stderr),
      exited,
      get exitCode() {
        return exitCode
      },
      kill,
    }
  }

  /**
   * Converts child output to a web stream and starts consuming immediately; unread data queues in memory.
   * Readable.toWeb applies backpressure, so a caller that waits for exit before reading would leave a chatty child
   * blocked on a full pipe.
   */
  function drain(stream: Readable): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        stream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
        stream.once("end", () => controller.close())
        stream.once("error", (error) => controller.error(error))
      },
      cancel() {
        stream.destroy()
      },
    })
  }

  export type RunOptions = Omit<SpawnOptions, "stdin" | "stdout" | "stderr"> & {
    /** Content written to the child's stdin */
    stdin?: string | Uint8Array
    /** Return the result instead of throwing on a non-zero exit code */
    nothrow?: boolean
  }

  export type RunResult = {
    exitCode: number
    stdout: Buffer
    stderr: Buffer
    text(): string
  }

  export class RunError extends Error implements RunResult {
    constructor(
      readonly command: string[],
      readonly exitCode: number,
      readonly stdout: Buffer,
      readonly stderr: Buffer,
    ) {
      super(`Command failed with exit code ${exitCode}: ${command.join(" ")}\n${stderr.toString().trim()}`)
      this.name = "RunError"
    }

    text() {
      return this.stdout.toString()
    }
  }

  /**
   * Runs a command and collects its output. Throws RunError on a non-zero exit code by default; with nothrow, even a
   * missing command returns a failed result.
   */
  export async function run(cmd: string[], options: RunOptions = {}): Promise<RunResult> {
    const { stdin, nothrow, ...rest } = options
    const result = await (async () => {
      const child = spawn(cmd, {
        ...rest,
        stdin: stdin === undefined ? "ignore" : "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      if (stdin !== undefined) child.stdin!.end(stdin)
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).arrayBuffer(),
      ])
      return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) }
    })().catch((error: unknown) => {
      if (!nothrow) throw error
      return {
        exitCode: 127,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(error instanceof Error ? error.message : String(error)),
      }
    })
    if (result.exitCode !== 0 && !nothrow) throw new RunError(cmd, result.exitCode, result.stdout, result.stderr)
    return { ...result, text: () => result.stdout.toString() }
  }

  /**
   * Looks up a command on PATH and returns its absolute path. Commands containing a path separator resolve against
   * cwd. Returns null when not found.
   */
  export function which(command: string, options: { PATH?: string; cwd?: string } = {}): string | null {
    const cwd = options.cwd ?? process.cwd()
    const windows = platform() === "win32"
    const extensions = windows ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : []
    const explicit = command.includes("/") || (windows && command.includes("\\"))
    const bases = explicit
      ? [path.resolve(cwd, command)]
      : (options.PATH ?? process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.resolve(cwd, dir, command))
    for (const base of bases) {
      const candidates = windows
        ? (path.extname(base) ? [base] : []).concat(extensions.map((ext) => base + ext.toLowerCase()))
        : [base]
      const found = candidates.find(executable)
      if (found) return found
    }
    return null
  }

  function executable(file: string) {
    try {
      if (!statSync(file).isFile()) return false
      if (platform() !== "win32") accessSync(file, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }
}
