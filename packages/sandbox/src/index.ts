/**
 * @merakcode/sandbox: runs the agent's shell commands so they can only write approved folders, cannot read
 * credential folders, and reach the network only through a local proxy that asks before contacting new hosts.
 *
 * Built only from what the operating system provides: a separate account, NTFS permissions and the firewall on
 * Windows, Landlock on Linux, Seatbelt on macOS. The same Policy means the same thing on all three.
 */
import { randomUUID } from "node:crypto"
import type { Backend, Launch, Status } from "./backend"
import { SandboxEnv } from "./env"
import { Guard } from "./guard"
import type { Policy } from "./policy"
import { SandboxProxy } from "./proxy"
import { Report } from "./report"
import { LinuxSandbox } from "./linux"
import { MacSandbox } from "./macos"
import { WindowsSandbox } from "./windows"

export type { Backend, Launch, Status } from "./backend"
export { Policy } from "./policy"
export { Domain } from "./domain"
export type { SandboxProxy } from "./proxy"

export namespace Sandbox {
  export type Prepared = Launch & {
    /** Call when the command has ended; returns what the sandbox stopped, to append to the output ("" if nothing) */
    finish(output: string, exitCode: number | null): string
  }

  /** The backend for this operating system */
  export function backend(platform = process.platform): Backend {
    if (platform === "win32") return WindowsSandbox.create()
    if (platform === "linux") return LinuxSandbox.create()
    if (platform === "darwin") return MacSandbox.create()
    return {
      status: async () => ({ status: "unsupported", reason: `There is no sandbox for ${platform}` }),
      wrap: async () => {
        throw new Error(`There is no sandbox for ${platform}`)
      },
    }
  }

  export function create(
    backend: Backend,
    options: { platform?: NodeJS.Platform; lookup?: (host: string) => Promise<string> } = {},
  ) {
    const platform = options.platform ?? process.platform
    let proxy: Promise<SandboxProxy.Handle> | undefined

    return {
      status: (): Promise<Status> => backend.status(),
      setup: (progress?: (step: string) => void): Promise<Status> =>
        backend.setup ? backend.setup(progress) : backend.status(),
      reset: (): Promise<Status> => (backend.reset ? backend.reset() : backend.status()),

      /** Prepares one command; spawn `file` with `args` and `env` instead of the shell */
      async prepare(input: {
        command: string
        shell: string
        cwd: string
        env: Record<string, string | undefined>
        policy: Policy
        /** Temp folder for the command when the backend has none of its own */
        tmp: string
        /** Asked about hosts that are neither allowed nor denied; the answer counts for the rest of this command */
        ask: (req: SandboxProxy.Request) => Promise<boolean>
      }): Promise<Prepared> {
        const handle = await (proxy ??= SandboxProxy.start({ lookup: options.lookup }))
        const owner = randomUUID()
        handle.register(owner, {
          allow: input.policy.network.allow,
          deny: input.policy.network.deny,
          blockPorts: input.policy.network.blockPorts,
          ask: input.ask,
        })
        try {
          const before = Guard.snapshot(input.policy.write.protect)
          const env = SandboxEnv.build({
            platform,
            proxy: handle.url(owner),
            tmp: backend.tmp?.() ?? input.tmp,
            base: input.env,
          })
          const launch = await backend.wrap({
            command: input.command,
            shell: input.shell,
            cwd: input.cwd,
            env,
            policy: input.policy,
            proxyPort: handle.port,
          })
          let done = false
          return {
            file: launch.file,
            args: launch.args,
            env: launch.env,
            finish(output, exitCode) {
              if (done) return ""
              done = true
              launch.cleanup?.()
              const restored = Guard.restore(input.policy.write.protect, before)
              const blocked = handle.blocked(owner)
              handle.unregister(owner)
              return Report.render({ blocked, restored, output, exitCode })
            },
          }
        } catch (error) {
          handle.unregister(owner)
          throw error
        }
      },

      async close() {
        const current = proxy
        proxy = undefined
        if (current) await (await current).close()
      },
    }
  }
}
