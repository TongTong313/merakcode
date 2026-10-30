import os from "os"
import path from "path"
import z from "zod"
import { Sandbox, Domain, type Backend, type Policy } from "../../infra/sandbox/index"
import { NamedError } from "@merakcode/util/error"
import { Log } from "@merakcode/log/logger"
import { Config } from "@merakcode/engine/agent/settings/index"
import { Flag } from "../../infra/flag/flag"
import { Instance } from "../../infra/project/instance"
import { PermissionNext } from "./next"
import { PermissionPolicy } from "./policy"
import { SandboxPolicy } from "./sandbox-policy"
import { EngineAddress } from "../../infra/process/engine-address"
import type { Tool } from "../tools/tool"
import { lazy } from "@merakcode/util/lazy"

/**
 * Permission decisions for sandboxed commands: they may only write the
 * workspace, temp dirs, package caches and approved folders, cannot read credential folders, and reach the network
 * only through a local proxy that asks the session about new hosts. Commands you type yourself, MCP servers,
 * formatters and LSP never run sandboxed.
 */
export namespace PermissionExecution {
  const log = Log.create({ service: "sandbox" })

  export const Info = z
    .object({
      status: z.enum(["on", "off", "unsupported"]),
      backend: z.enum(["windows-account", "landlock", "seatbelt"]).optional(),
      /** Why it is not on */
      reason: z.string().optional(),
      /** What this system cannot enforce, e.g. network-not-enforced */
      degraded: z.array(z.string()).optional(),
      /** A one-time setup (POST /sandbox/install) would turn it on */
      installable: z.boolean().optional(),
    })
    .meta({ ref: "SandboxStatus" })
  export type Info = z.infer<typeof Info>
  export type Mode = "preferred" | "required" | "off"

  export const SetupRequiredError = NamedError.create(
    "SandboxSetupRequiredError",
    z.object({ message: z.string(), reason: z.string().optional() }),
  )

  let backend: Backend | undefined
  const sandbox = lazy(() => Sandbox.create(backend ?? Sandbox.backend(SandboxPolicy.base(os.homedir()))))

  /** Tests: use this backend instead of the one for the current system */
  export function useBackendForTest(next: Backend | undefined) {
    backend = next
    sandbox.reset()
  }

  export async function mode(): Promise<Mode> {
    const override = Flag.MERAKCODE_SANDBOX_MODE
    if (override === "preferred" || override === "required" || override === "off") return override
    // Engine startup has no project yet; the sandbox account is per machine, so the global config decides.
    const config = Instance.has() ? await Config.get() : await Config.getGlobal()
    return config.sandbox?.mode ?? "preferred"
  }

  /** Approved writable folders: sandbox rules written as directories ("/abs/dir/*") that evaluate to allow */
  function writableFrom(ruleset: PermissionNext.Ruleset) {
    return (
      ruleset
        .filter((rule) => rule.permission === "sandbox" && rule.action === "allow" && rule.pattern.endsWith("/*"))
        .map((rule) => rule.pattern)
        .filter((pattern) => /^(\/|[a-z]:\/)/i.test(pattern) && pattern.length > 2)
        .filter((pattern) => PermissionNext.evaluate("sandbox", pattern, ruleset).action === "allow")
        // Drive letters are lower case in rules (PermissionNext.normalizePath); paths use upper case
        .map((pattern) =>
          path.resolve(pattern.slice(0, -2)).replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`),
        )
    )
  }

  /** What a command may do, from the session's workspace, its rules and the sandbox config */
  export function policy(input: {
    workspace: string[]
    home: string
    tmp: string
    writable?: string[]
    ruleset?: PermissionNext.Ruleset
    config?: Config.Info["sandbox"]
    enginePort?: number
  }): Policy {
    const ruleset = input.ruleset ?? []
    const network = (action: "allow" | "deny") =>
      ruleset.filter((rule) => rule.permission === "network" && rule.action === action).map((rule) => rule.pattern)
    return SandboxPolicy.build({
      workspace: input.workspace,
      home: input.home,
      tmp: input.tmp,
      writable: [...(input.writable ?? []), ...writableFrom(ruleset), ...(input.config?.write?.allow ?? [])],
      readDeny: input.config?.read?.deny,
      network: {
        allow: [...PermissionPolicy.NETWORK_ALLOW, ...network("allow").filter((pattern) => pattern !== "*")],
        deny: network("deny").filter(Domain.valid),
        blockPorts: input.enginePort ? [input.enginePort] : [],
        localPorts: input.config?.network?.allowLocalPorts,
      },
    })
  }

  /** Status shown in the status bar, settings and `merak sandbox status` */
  export async function current(): Promise<Info> {
    const status = await sandbox().status()
    // Off still reports whether a one-time setup remains, so the conversation control can offer it.
    if ((await mode()) === "off") return { ...status, status: "off" }
    return status
  }

  /**
   * Brings an already set up sandbox to ready when the engine starts. Does not create the Windows account; that
   * still takes the one-time setup.
   */
  export async function wake(): Promise<Info> {
    const status = await current()
    if (status.status === "on") await sandbox().warm()
    return current()
  }

  /** Commands are not waiting on sandbox setup: it is on, or the user turned it off */
  export async function ready(): Promise<boolean> {
    if ((await mode()) === "off") return true
    return (await current()).status === "on"
  }

  export async function install(progress?: (step: string) => void): Promise<Info> {
    const status = await sandbox().setup((step) => {
      log.info("setup", { step })
      progress?.(step)
    })
    log.info("setup finished", { status: status.status })
    const reported = (await mode()) === "off" ? { ...status, status: "off" as const } : status
    if (reported.status === "on") await import("./flush").then((m) => m.PermissionFlush.run())
    return reported
  }

  export async function reset(): Promise<Info> {
    const status = await sandbox().reset()
    log.info("reset finished", { status: status.status })
    return (await mode()) === "off" ? { ...status, status: "off" as const } : status
  }

  /** True when commands that change things must ask first because the sandbox should be used but is not ready */
  export async function missing() {
    const configured = await mode()
    if (configured === "off") return false
    const status = await current()
    if (status.status === "on") return false
    if (configured === "required")
      throw new SetupRequiredError({
        message:
          "The sandbox is required but not ready. Set it up in the desktop app under Settings → Permissions & security (or run merak sandbox setup), or set sandbox.mode to preferred.",
        reason: status.reason,
      })
    return true
  }

  export type Prepared = Sandbox.Prepared

  /** How to start a command inside the sandbox, or undefined to run it as usual */
  export async function wrap(input: {
    command: string
    shell: string
    cwd: string
    env: Record<string, string | undefined>
    ctx: Tool.Context
    workspace: string[]
    writable?: string[]
  }): Promise<Prepared | undefined> {
    if ((await mode()) === "off") return
    if ((await current()).status !== "on") return
    const config = (await Config.get()).sandbox
    return sandbox().prepare({
      command: input.command,
      shell: input.shell,
      cwd: input.cwd,
      env: input.env,
      tmp: os.tmpdir(),
      policy: policy({
        workspace: input.workspace,
        home: os.homedir(),
        tmp: os.tmpdir(),
        writable: input.writable,
        ruleset: input.ctx.ruleset,
        config,
        enginePort: EngineAddress.port(),
      }),
      ask: (req) =>
        input.ctx
          .ask({
            permission: "network",
            checks: [PermissionPolicy.network(req.host)],
            metadata: { host: req.host, port: req.port, command: input.command },
          })
          .then(
            () => true,
            () => false,
          ),
    })
  }
}
