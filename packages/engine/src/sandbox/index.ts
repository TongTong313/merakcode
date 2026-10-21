import os from "os"
import path from "path"
import z from "zod"
import { Sandbox as Runner, Policy, Domain, type Backend } from "@merakcode/sandbox"
import { NamedError } from "@merakcode/util/error"
import { Log } from "@merakcode/log/logger"
import { Config } from "../config/config"
import { Flag } from "../flag/flag"
import { PermissionNext } from "../permission/next"
import { PermissionPolicy } from "../permission/policy"
import { ServerAddress } from "../server/address"
import type { Tool } from "../tool/tool"
import { lazy } from "../util/lazy"

/**
 * Engine side of the OS sandbox (@merakcode/sandbox) for commands the agent runs: they may only write the
 * workspace, temp dirs, package caches and approved folders, cannot read credential folders, and reach the network
 * only through a local proxy that asks the session about new hosts. Commands you type yourself, MCP servers,
 * formatters and LSP never run sandboxed.
 */
export namespace Sandbox {
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
  const runner = lazy(() => Runner.create(backend ?? Runner.backend()))

  /** Tests: use this backend instead of the one for the current system */
  export function useBackendForTest(next: Backend | undefined) {
    backend = next
    runner.reset()
  }

  export async function mode(): Promise<Mode> {
    const override = Flag.MERAKCODE_SANDBOX_MODE
    if (override === "preferred" || override === "required" || override === "off") return override
    return (await Config.get()).sandbox?.mode ?? "preferred"
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
    return Policy.build({
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
    if ((await mode()) === "off") return { status: "off" }
    return runner().status()
  }

  export async function install(progress?: (step: string) => void): Promise<Info> {
    const status = await runner().setup((step) => {
      log.info("setup", { step })
      progress?.(step)
    })
    log.info("setup finished", { status: status.status })
    return (await mode()) === "off" ? { status: "off" } : status
  }

  export async function reset(): Promise<Info> {
    const status = await runner().reset()
    log.info("reset finished", { status: status.status })
    return (await mode()) === "off" ? { status: "off" } : status
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

  export type Prepared = Runner.Prepared

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
    return runner().prepare({
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
        enginePort: ServerAddress.port(),
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
