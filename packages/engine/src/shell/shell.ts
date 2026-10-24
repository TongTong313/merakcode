import { Flag } from "../flag/flag"
import { lazy } from "../util/lazy"
import path from "path"
import os from "os"
import { statSync } from "fs"
import { spawn } from "child_process"
import { Process } from "@merakcode/util/process"
import { setTimeout as delay } from "node:timers/promises"

const SIGKILL_TIMEOUT_MS = 200

export namespace Shell {
  export async function killTree(
    proc: { readonly pid?: number; kill(signal?: NodeJS.Signals): unknown },
    opts?: { exited?: () => boolean },
  ): Promise<void> {
    const pid = proc.pid
    if (!pid || opts?.exited?.()) return

    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        // Hidden: a process without a console of its own (a detached member adapter) would open a window for it
        const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore", windowsHide: true })
        killer.once("exit", () => resolve())
        killer.once("error", () => resolve())
      })
      return
    }

    try {
      process.kill(-pid, "SIGTERM")
      await delay(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        process.kill(-pid, "SIGKILL")
      }
    } catch (_e) {
      proc.kill("SIGTERM")
      await delay(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        proc.kill("SIGKILL")
      }
    }
  }
  const BLACKLIST = new Set(["fish", "nu"])

  function fallback() {
    if (process.platform === "win32") {
      if (Flag.MERAKCODE_GIT_BASH_PATH) return Flag.MERAKCODE_GIT_BASH_PATH
      const git = Process.which("git")
      if (git) {
        // git.exe is typically at: C:\Program Files\Git\cmd\git.exe
        // bash.exe is at: C:\Program Files\Git\bin\bash.exe
        const bash = path.join(git, "..", "..", "bin", "bash.exe")
        if (statSync(bash, { throwIfNoEntry: false })?.size) return bash
      }
      return process.env.COMSPEC || "cmd.exe"
    }
    if (process.platform === "darwin") return "/bin/zsh"
    const bash = Process.which("bash")
    if (bash) return bash
    return "/bin/sh"
  }

  export const preferred = lazy(() => {
    const s = process.env.SHELL
    if (s) return s
    return fallback()
  })

  export type RunResult = {
    exitCode: number
    stdout: Buffer
    stderr: Buffer
    text(): string
  }

  /**
   * Runs a full command line in the same shell as the bash tool (acceptable()) and collects its output; a non-zero
   * exit does not throw. Used by !`cmd` in command templates and by the plugin $, so commands behave the same whether
   * the model, a template or a plugin runs them.
   */
  export function run(
    command: string,
    options: {
      cwd?: string
      env?: Record<string, string>
      /** env replaces the process environment instead of being merged into it */
      replaceEnv?: boolean
      signal?: AbortSignal
      timeout?: number
    } = {},
  ) {
    return new Promise<RunResult>((resolve) => {
      const child = spawn(command, {
        shell: acceptable(),
        cwd: options.cwd,
        env: options.replaceEnv ? options.env : { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        signal: options.signal,
        timeout: options.timeout,
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
      const finish = (exitCode: number, error?: Error) => {
        const out = Buffer.concat(stdout)
        const err = error ? Buffer.concat([...stderr, Buffer.from(error.message)]) : Buffer.concat(stderr)
        resolve({ exitCode, stdout: out, stderr: err, text: () => out.toString() })
      }
      child.once("error", (error) => finish(127, error))
      child.once("close", (code, signal) => finish(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)))
    })
  }

  /** Single-quotes one argument by POSIX rules for use in a shell command line */
  export function quote(value: string) {
    if (value === "") return "''"
    if (/^[\w@%+=:,./-]+$/.test(value)) return value
    return `'${value.replaceAll("'", `'\\''`)}'`
  }

  export const acceptable = lazy(() => {
    const s = process.env.SHELL
    if (s && !BLACKLIST.has(process.platform === "win32" ? path.win32.basename(s) : path.basename(s))) return s
    return fallback()
  })
}
