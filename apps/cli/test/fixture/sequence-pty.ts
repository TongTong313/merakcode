import { spawn } from "@lydell/node-pty"
import stripAnsi from "strip-ansi"
import { join } from "node:path"
import { alive, product, sequence, until } from "./sdk-sequence"
import { Filesystem } from "@merakcode/util/filesystem"

/** A real attach client or owned TUI/server; terminal contents stay in memory and never enter evidence. */
export async function pty(
  kit: Awaited<ReturnType<typeof sequence>>,
  sessionID: string,
  title: string,
  url = kit.url,
  owned = false,
  observe?: (chunk: string) => void,
) {
  let output = ""
  let exited = false
  let exit: { exitCode: number; signal?: string | number; source: string } | undefined
  let terminating = false
  const [command, ...args] = product(
    ...(owned
      ? [kit.project, "--port", new URL(url).port, "--hostname", "127.0.0.1"]
      : ["attach", url, "--dir", kit.project]),
    "--session",
    sessionID,
  )
  const terminal = spawn(command, args, { cwd: kit.project, env: kit.env, cols: 140, rows: 45, name: "xterm-256color" })
  terminal.onExit((event) => {
    exited = true
    exit ??= { ...event, source: terminating ? "cleanup-event" : "natural" }
  })
  terminal.onData((chunk) => {
    observe?.(chunk)
    output += stripAnsi(chunk)
    if (chunk.includes("\x1b]11;?")) terminal.write("\x1b]11;rgb:0000/0000/0000\x07")
    if (chunk.includes("\x1b[6n")) terminal.write("\x1b[1;1R")
  })
  // The terminal UI is transpiled from source on the fly (tsx + Solid); a cold start on Windows takes about 10 s, so
  // each wait gets a generous timeout too
  const wait = (check: () => unknown | Promise<unknown>, label: string, timeout = 30_000) =>
    until(
      async () => {
        if (exited) throw new Error(`PTY exited before ${label}`)
        return check()
      },
      label,
      timeout,
    )
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      let stopped = false
      try {
        if (!exited) {
          terminating = true
          terminal.kill()
        }
        // kill() may emit an exit event before the process is gone. Only actual PID
        // absence proves reclamation; cleanup events never prove normal exit.
        await until(() => !alive(terminal.pid), "owned PTY PID reclaimed", 5000)
        stopped = true
      } finally {
        await Filesystem.write(
          join(kit.artifacts, `terminal-summary-${terminal.pid}.json`),
          JSON.stringify({
            bytes: output.length,
            exited,
            exit,
            terminating,
            stopped,
            entry: owned ? "owned-tui" : "attach",
            pid: terminal.pid,
          }),
        )
      }
    })())
  kit.registerCleanup("PTY", terminal.pid, close)
  const pasted = (text: string, offset: number) => {
    const value = text.trim()
    const lines = value.split("\n").length
    const label = lines >= 3 || value.length > 150 ? `[已粘贴约 ${lines} 行]` : text.split("\n").at(-1)!
    return output.slice(offset).includes(label)
  }
  try {
    await wait(
      () => output.includes(title) || /输入消息|Enter message|Ask anything|本次允许|Allow once/.test(output),
      "PTY ready",
      60_000,
    )
  } catch (error) {
    await close()
    throw error
  }
  return {
    pid: terminal.pid,
    wait,
    close,
    write: (text: string) => terminal.write(text),
    offset: () => output.length,
    exited: () => {
      if (!exited) return false
      if (exit?.source !== "natural" || exit.exitCode !== 0 || exit.signal)
        throw new Error(
          `PTY normal exit failed: code=${exit?.exitCode}; source=${exit?.source}; signal=${exit?.signal ?? "none"}`,
        )
      return !alive(terminal.pid)
    },
    exit: () => exit,
    visible: (text: string, offset = 0) => output.slice(offset).includes(text),
    async paste(text: string) {
      const offset = output.length
      terminal.write(`\x1b[200~${text}\x1b[201~`)
      await wait(() => pasted(text, offset), "pasted prompt visible")
      return offset
    },
    async submit(text: string) {
      const offset = output.length
      terminal.write(`\x1b[200~${text}\x1b[201~`)
      await wait(() => pasted(text, offset), "typed prompt visible")
      terminal.write("\r")
      return offset
    },
  }
}
