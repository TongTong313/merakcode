import type { IPty } from "@lydell/node-pty"
import { containProcess } from "./tree"
import { randomUUID } from "node:crypto"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

// The launcher waits until the host has installed process containment before starting user code.
const launcher = String.raw`const fs = require('node:fs')
const { spawn } = require('node:child_process')
const [gate, command, args, nodeOptions] = JSON.parse(Buffer.from(process.argv[1], 'base64').toString())
const timer = setInterval(() => {
  if (!fs.existsSync(gate)) return
  clearInterval(timer)
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...nodeOptions } })
  child.on('error', () => process.exit(127))
  child.on('exit', (code) => process.exit(code ?? 1))
}, 10)`

/**
 * Pseudo terminal (node-pty), with fixes applied by attach():
 * - On every system node-pty rethrows an error on the terminal's output socket (anything but EIO) unless the terminal
 *   has a second error listener, so an EPIPE there became an uncaught exception that took the engine down. node-pty
 *   has already closed the terminal by then, so a listener that ignores the error is enough
 * - Windows (ConPTY): after the child exits, node-pty does not release its conout reader thread and input pipe, so
 *   the host process cannot exit: release them explicitly on exit
 * - Windows: killing a child that has already exited throws because AttachConsole fails: skip kill / write / resize
 *   once exited
 * - Windows: input sent before the terminal is ready is queued; if the terminal closes right away, the queued input
 *   hits a broken pipe and the unhandled write error surfaces as an uncaught exception: ignore all input pipe errors
 *   (a broken pipe means the terminal is gone and nothing can be recovered)
 *
 * On Windows node-pty emits exit only after output is drained and the read pipe is closed, so releasing in onExit
 * does not lose output.
 */
export namespace NativePty {
  export type Options = {
    name?: string
    cols?: number
    rows?: number
    cwd?: string
    env?: Record<string, string>
  }

  export type Process = {
    readonly pid: number
    onData(listener: (data: string) => void): void
    onExit(listener: (event: { exitCode: number }) => void): void
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(): void
    stop(): Promise<void>
  }

  export async function spawn(command: string, args: string[], options: Options = {}): Promise<Process> {
    const pty = await import("@lydell/node-pty")
    const directory = await mkdtemp(path.join(os.tmpdir(), "merakcode-pty-"))
    const gate = path.join(directory, "ready")
    const marker = { name: "MERAKCODE_TERMINAL_RUN", value: randomUUID() }
    const env = { ...(options.env ?? process.env), [marker.name]: marker.value }
    const child = await (async () => {
      try {
        return pty.spawn(
          process.execPath,
          [
            "-e",
            launcher,
            Buffer.from(
              JSON.stringify([
                gate,
                command,
                args,
                Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() === "NODE_OPTIONS")),
              ]),
            ).toString("base64"),
          ],
          {
            name: options.name ?? "xterm-256color",
            cols: options.cols ?? 80,
            rows: options.rows ?? 24,
            cwd: options.cwd,
            // User preloads run only in the contained command, after the launcher has opened the gate.
            env: Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "NODE_OPTIONS")),
          },
        )
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
    })()
    const state = attach(child)
    const release = await containProcess(
      {
        pid: child.pid,
        kill: (signal) => {
          if (!state.exited) child.kill(signal)
        },
      },
      marker,
      async (text) => text.en,
    ).catch(async (error) => {
      if (!state.exited) child.kill()
      await rm(directory, { recursive: true, force: true })
      throw error
    })
    try {
      await writeFile(gate, "ready")
    } catch (error) {
      await release()
      await rm(directory, { recursive: true, force: true })
      throw error
    }
    let stopping: Promise<void> | undefined
    const stop = () =>
      (stopping ??= release()
        .then(() => rm(directory, { recursive: true, force: true }))
        .catch((error) => {
          stopping = undefined
          throw error
        }))
    child.onExit(() => {
      void stop().catch(() => {})
    })
    return {
      get pid() {
        return child.pid
      },
      onData: (listener) => void child.onData(listener),
      onExit: (listener) => void child.onExit(({ exitCode }) => listener({ exitCode })),
      write: (data) => {
        if (!state.exited) child.write(data)
      },
      resize: (cols, rows) => {
        if (!state.exited) child.resize(cols, rows)
      },
      kill: () => {
        if (!state.exited) child.kill()
      },
      stop,
    }
  }

  /** Applies the fixes described above to a node-pty terminal; exited turns true once it has exited */
  export function attach(child: IPty) {
    const state = { exited: false }
    ;(child as unknown as { on(event: "error", listener: () => void): void }).on("error", () => {})
    if (process.platform === "win32") windowsAgent(child)?._inSocket?.on?.("error", () => {})
    child.onExit(() => {
      state.exited = true
      if (process.platform === "win32") release(child)
    })
    return state
  }

  type WindowsAgent = {
    _conoutSocketWorker?: { dispose(): void }
    _inSocket?: { destroy(): void; on?(event: "error", listener: () => void): unknown }
  }

  const windowsAgent = (child: IPty) => (child as unknown as { _agent?: WindowsAgent })._agent

  function release(child: IPty) {
    const agent = windowsAgent(child)
    agent?._conoutSocketWorker?.dispose()
    agent?._inSocket?.destroy()
  }
}
