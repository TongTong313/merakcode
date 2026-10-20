import { Instance } from "../project/instance"
import os from "os"
import { Process } from "@merakcode/util/process"

export namespace Env {
  const state = Instance.state(() => {
    // Create a shallow copy to isolate environment per instance
    // Prevents parallel tests from interfering with each other's env vars
    return { ...process.env } as Record<string, string | undefined>
  })

  export function get(key: string) {
    const env = state()
    return env[key]
  }

  export function all() {
    return state()
  }

  export function set(key: string, value: string) {
    const env = state()
    env[key] = value
  }

  export function remove(key: string) {
    const env = state()
    delete env[key]
  }

  /**
   * Re-reads the given keys from the real system environment and syncs them into process.env.
   *
   * - macOS / Linux: starts a login interactive shell so the shell profile is read
   * - Windows: reads the registry (Machine + User) through PowerShell
   *
   * Only the listed keys are added, removed or updated; other process.env entries are left alone.
   */
  export async function reload(keys: string[]) {
    if (keys.length === 0) return
    try {
      const freshEnv = await readFreshEnv()
      for (const key of keys) {
        if (key in freshEnv) {
          process.env[key] = freshEnv[key]
        } else {
          delete process.env[key]
        }
      }
    } catch {
      // Keep the old values on failure
    }
    state.invalidateAll()
  }

  /** Reads the current system environment variables on any platform */
  async function readFreshEnv(): Promise<Record<string, string>> {
    if (process.platform === "win32") {
      return readFreshEnvWindows()
    }
    return readFreshEnvUnix()
  }

  /** macOS / Linux: read through a login interactive shell */
  async function readFreshEnvUnix(): Promise<Record<string, string>> {
    const shell = process.env.SHELL || "/bin/sh"
    const home = os.homedir()
    // Markers separate the env output from shell startup noise (oh-my-zsh and similar frameworks)
    const marker = `__MERAKCODE_ENV_${Date.now()}__`
    const proc = Process.spawn([shell, "-lic", `echo '${marker}'; env; echo '${marker}'`], {
      stdout: "pipe",
      stderr: "ignore",
      env: { HOME: home, TERM: "dumb" },
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited

    const start = output.indexOf(marker)
    const end = output.lastIndexOf(marker)
    if (start === -1 || end === -1 || start === end) return {}
    const envBlock = output.slice(start + marker.length, end).trim()

    return parseEnvOutput(envBlock)
  }

  /** Windows: read the registry (Machine + User) through PowerShell */
  async function readFreshEnvWindows(): Promise<Record<string, string>> {
    const script = [
      "$a=@{}",
      "[Environment]::GetEnvironmentVariables('Machine').GetEnumerator()|%{$a[$_.Key]=$_.Value}",
      "[Environment]::GetEnvironmentVariables('User').GetEnumerator()|%{$a[$_.Key]=$_.Value}",
      '$a.GetEnumerator()|%{Write-Output "$($_.Key)=$($_.Value)"}',
    ].join(";")
    const proc = Process.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return parseEnvOutput(output)
  }

  function parseEnvOutput(output: string): Record<string, string> {
    const result: Record<string, string> = {}
    for (const line of output.split(/\r?\n/)) {
      const idx = line.indexOf("=")
      if (idx > 0) result[line.slice(0, idx)] = line.slice(idx + 1)
    }
    return result
  }
}
