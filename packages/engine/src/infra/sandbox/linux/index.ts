/**
 * Linux backend: Landlock, through a small Node helper (exec.ts) that restricts itself and becomes the shell.
 * Needs no root and no setup. Network rules need Landlock ABI 4 (Linux 6.7); older kernels still get the file
 * rules. Landlock matches TCP connections by port only, and does not cover UDP or Unix sockets.
 */
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { native } from "@merakcode/util/ffi"
import { Runtime } from "@merakcode/util/runtime"
import type { Backend, Status } from "../backend"
import type { Request } from "./exec"
import { Landlock } from "./landlock"
import { SandboxRequest } from "./request"

export namespace LinuxSandbox {
  /** Landlock ABI version of the running kernel; 0 when Landlock or FFI is unavailable */
  export function abi() {
    const ffi = native()
    if (!ffi || process.platform !== "linux") return 0
    try {
      const values = [Landlock.SYS.createRuleset, 0, 0, Landlock.CREATE_RULESET_VERSION, 0, 0].map(BigInt)
      return Math.max(0, Number(ffi.call("libc.so.6", "syscall", Array(6).fill("int64"), "int64", values)))
    } catch {
      return 0
    }
  }

  /**
   * How to start the helper: the bundled lib/sandbox-linux.js in a release, the TypeScript source with the
   * development loader otherwise
   */
  export function helper(here = import.meta.url, execArgv = Runtime.execArgv()): string[] {
    const bundled = fileURLToPath(new URL("./sandbox-linux.js", here))
    if (existsSync(bundled)) return [process.execPath, "--disable-warning=ExperimentalWarning", bundled]
    return [
      process.execPath,
      ...execArgv,
      "--disable-warning=ExperimentalWarning",
      fileURLToPath(new URL("./exec.ts", here)),
    ]
  }

  export function create(): Backend {
    const requests = path.join(os.tmpdir(), "merakcode-sandbox")
    return {
      async status(): Promise<Status> {
        const version = abi()
        if (version < 1)
          return {
            status: "unsupported",
            reason: "Landlock is not available: it needs Linux 5.13 or newer with Landlock enabled",
          }
        return {
          status: "on",
          backend: "landlock",
          degraded: [
            ...(version < 4 ? ["network-not-enforced"] : []),
            "tcp-matched-by-port",
            "udp-not-restricted",
            "unix-socket-not-restricted",
          ],
        }
      },

      async wrap(input) {
        mkdirSync(requests, { recursive: true, mode: 0o700 })
        const file = path.join(requests, `${randomUUID()}.json`)
        const request: Request = {
          shell: input.shell,
          command: input.command,
          env: input.env,
          readDeny: input.policy.read.deny,
          write: input.policy.write.allow,
          ports: [input.proxyPort, ...input.policy.network.localPorts],
        }
        const content = JSON.stringify(request)
        // wx: never write through a file someone else created first
        writeFileSync(file, content, { mode: 0o600, flag: "wx" })
        const [node, ...args] = helper()
        return {
          file: node!,
          args: [...args, file, SandboxRequest.digest(content)],
          env: {},
          cleanup: () => rmSync(file, { force: true }),
        }
      },
    }
  }
}
