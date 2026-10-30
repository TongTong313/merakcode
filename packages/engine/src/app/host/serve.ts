import { Server } from "../server/server"
import { Instance } from "../../infra/project/instance"
import { BashJobStore } from "../../agent/tools/bash-background"
import { MemoryExtract } from "../../agent/memory/extract"
import { SessionMemory } from "../../agent/memory/session-memory/session-memory"
import { AutoDream } from "../../agent/memory/dream/dream"
import { Config } from "../config/files/config"
import { ConfigWatch } from "../config/files/config-watch"
import { SkillWatch } from "../../agent/skill/skill-watch"
import { RuleWatch } from "../../agent/prompt/rules/watch"
import { PermissionExecution } from "../../agent/permission/execution"
import { Provider } from "../../agent/model/provider"
import { Log } from "@merakcode/log/logger"
import { Global } from "../../infra/global"
import { CronScheduler } from "../task/cron"

export type NetworkArgs = {
  port?: number
  hostname: string
  mdns: boolean
  "mdns-domain": string
  cors?: string[] | string
}

/** Command-line values win when they were given explicitly; otherwise the server section of the config applies */
export async function resolveNetwork(args: NetworkArgs, argv = process.argv) {
  const config = await Config.global()
  const explicit = (flag: string) => argv.includes(flag)
  const mdns = explicit("--mdns") ? args.mdns : (config?.server?.mdns ?? args.mdns)
  const mdnsDomain = explicit("--mdns-domain")
    ? args["mdns-domain"]
    : (config?.server?.mdnsDomain ?? args["mdns-domain"])
  const port = explicit("--port") ? args.port : (config?.server?.port ?? args.port)
  const hostname = explicit("--hostname")
    ? args.hostname
    : mdns && !config?.server?.hostname
      ? "0.0.0.0"
      : (config?.server?.hostname ?? args.hostname)
  const cors = [
    ...(config?.server?.cors ?? []),
    ...(Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []),
  ]
  return { hostname, port, mdns, mdnsDomain, cors }
}

/**
 * Starts the HTTP server and keeps it running until `waitForShutdown` resolves.
 * On shutdown, background memory work gets up to 3 seconds to finish before instances are disposed.
 */
export async function serve(
  args: NetworkArgs,
  hooks: {
    waitForShutdown: (cleanup: () => Promise<unknown>) => Promise<void>
    onListening?: (url: URL) => void
  },
) {
  await Global.initialize()
  CronScheduler.start()
  let stop = async () => {}
  try {
    // An already set up sandbox is prepared before the first command. Setup itself still waits for the user.
    await PermissionExecution.wake().catch((error) => Log.Default.warn("sandbox wake failed", { error }))
    await ConfigWatch.initGlobal()
    await SkillWatch.initGlobal()
    RuleWatch.initGlobal()
    const server = await Server.listen(await resolveNetwork(args))
    let stopping: Promise<void> | undefined
    stop = () => (stopping ??= server.stop(true))
    // The SDK reads this exact line from stdout to learn the address (see packages/sdk/js/src/process)
    console.log(`MerakCode server listening on http://${server.hostname}:${server.port}`)
    hooks.onListening?.(new URL(`http://${server.hostname}:${server.port}`))
    await hooks.waitForShutdown(async () => {
      const deadline = Date.now() + 3000
      const listener = stop()
      CronScheduler.stop()
      Provider.invalidateAll()
      const remaining = () => Math.max(0, deadline - Date.now())
      await Instance.forEach(() =>
        Promise.all([MemoryExtract.drain(remaining()), SessionMemory.drain(remaining()), AutoDream.drain(remaining())]),
      )
      await Promise.all([listener, BashJobStore.stopAll(), Instance.disposeAll()])
    })
  } finally {
    CronScheduler.stop()
    await Promise.all([stop(), ConfigWatch.disposeGlobal(), SkillWatch.disposeGlobal(), RuleWatch.disposeGlobal()])
  }
}
