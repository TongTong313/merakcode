/**
 * Command lines and request files for the Windows helper. Pure functions; the helper itself is helper.cs.
 */
import path from "node:path"

export namespace WindowsCommand {
  /** Firewall addresses blocked for the sandbox account: everything but 127.0.0.0/8, :: and ::1 */
  export const BLOCKED = [
    "0.0.0.0-126.255.255.255",
    "128.0.0.0-255.255.255.255",
    "::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  ]

  /** One argument quoted by the rules CommandLineToArgvW and the C runtime use */
  export function quote(arg: string) {
    if (arg && !/[\s"]/.test(arg)) return arg
    let result = '"'
    for (let i = 0; i < arg.length; i++) {
      let slashes = 0
      while (i < arg.length && arg[i] === "\\") {
        slashes++
        i++
      }
      if (i === arg.length) {
        result += "\\".repeat(slashes * 2)
        break
      }
      result += arg[i] === '"' ? "\\".repeat(slashes * 2 + 1) + '"' : "\\".repeat(slashes) + arg[i]
    }
    return result + '"'
  }

  /** Arguments that make `shell` run `command`, the same way Node's spawn({ shell }) does */
  export function line(shell: string, command: string) {
    if (/^cmd(\.exe)?$/i.test(path.win32.basename(shell))) return `/d /s /c "${command}"`
    return `-c ${quote(command)}`
  }

  /**
   * Environment for Windows PowerShell 5.1. Started from PowerShell 7, it would inherit a PSModulePath that points at
   * PowerShell 7's modules, which 5.1 cannot load (ConvertTo-SecureString fails); without the variable it uses its own
   */
  export function powershellEnv(env: Record<string, string | undefined>) {
    return Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && entry[0].toLowerCase() !== "psmodulepath",
      ),
    )
  }

  /** Request file for `helper run`: user, password file, cwd, program, arguments, then KEY=VALUE, all NUL separated */
  export function request(input: {
    user: string
    password: string
    cwd: string
    file: string
    args: string
    env: Record<string, string>
  }) {
    const fields = [
      input.user,
      input.password,
      input.cwd,
      input.file,
      input.args,
      ...Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
    ]
    if (fields.some((field) => field.includes("\0"))) throw new Error("A sandbox request field contains NUL")
    return fields.join("\0")
  }
}
