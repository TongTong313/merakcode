/**
 * macOS Seatbelt profile for `sandbox-exec`. Paths are passed as -D parameters and referenced with (param "…"),
 * so they never need escaping. Later rules override earlier ones, which is what the order below relies on.
 */
import type { Policy } from "../policy"

export namespace Seatbelt {
  /** Devices a shell writes to */
  const DEVICES = [
    '(literal "/dev/null")',
    '(literal "/dev/zero")',
    '(literal "/dev/tty")',
    '(regex #"^/dev/ttys[0-9]+$")',
    '(literal "/dev/dtracehelper")',
  ]

  export function profile(policy: Policy) {
    const params: string[] = []
    const names = (prefix: string, values: string[]) =>
      values.map((value, index) => {
        params.push("-D", `${prefix}${index}=${value}`)
        return `(param "${prefix}${index}")`
      })
    const write = names("W", policy.write.allow).map((name) => `(subpath ${name})`)
    const protect = names("P", policy.write.protect).map((name) => `(subpath ${name})`)
    const read = names("R", policy.read.deny).map((name) => `(subpath ${name})`)
    const engine = names(
      "E",
      policy.network.blockPorts.map((port) => `localhost:${port}`),
    ).map((name) => `(remote ip ${name})`)
    const lines = [
      "(version 1)",
      "(allow default)",
      `(deny file-write* (require-not (require-any ${[...write, ...DEVICES].join(" ")})))`,
      ...(protect.length ? [`(deny file-write* ${protect.join(" ")})`] : []),
      ...(read.length ? [`(deny file-read* ${read.join(" ")})`] : []),
      "(deny network-outbound)",
      '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))',
      ...(engine.length ? [`(deny network-outbound ${engine.join(" ")})`] : []),
      '(deny network-outbound (remote unix-socket (path-literal "/var/run/docker.sock")))',
    ]
    return { profile: lines.join("\n"), params }
  }

  export function command(input: { profile: string; params: string[]; shell: string; command: string }) {
    return ["/usr/bin/sandbox-exec", ...input.params, "-p", input.profile, input.shell, "-c", input.command]
  }
}
