import type { IPty } from "@lydell/node-pty"

/**
 * Pseudo terminal (node-pty), with three fixes for Windows (ConPTY):
 * - After the child exits, node-pty does not release its conout reader thread and input pipe, so the host process
 *   cannot exit: release them explicitly on exit
 * - Killing a child that has already exited throws because AttachConsole fails: skip kill / write / resize once exited
 * - Input sent before the terminal is ready is queued; if the terminal closes right away, the queued input hits a
 *   broken pipe and the unhandled write error surfaces as an uncaught exception: ignore all input pipe errors (a
 *   broken pipe means the terminal is gone and nothing can be recovered)
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
  }

  export async function spawn(command: string, args: string[], options: Options = {}): Promise<Process> {
    const pty = await import("@lydell/node-pty")
    const child = pty.spawn(command, args, {
      name: options.name ?? "xterm-256color",
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd,
      env: options.env,
    })
    let exited = false
    if (process.platform === "win32") windowsAgent(child)?._inSocket?.on?.("error", () => {})
    child.onExit(() => {
      exited = true
      if (process.platform === "win32") release(child)
    })
    return {
      get pid() {
        return child.pid
      },
      onData: (listener) => void child.onData(listener),
      onExit: (listener) => void child.onExit(({ exitCode }) => listener({ exitCode })),
      write: (data) => {
        if (!exited) child.write(data)
      },
      resize: (cols, rows) => {
        if (!exited) child.resize(cols, rows)
      },
      kill: () => {
        if (!exited) child.kill()
      },
    }
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
