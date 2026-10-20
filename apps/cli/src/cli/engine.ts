/**
 * Engine for the terminal UI, `run` and `acp`: spawns this program's own `serve` (same binary) through the SDK and
 * never loads engine code in-process. In development that is the source tree (with the source loader), in releases
 * lib/index.js; either way the current runtime and entry point are launched again.
 */
import path from "node:path"
import { startEngine, type Engine } from "@merakcode/sdk/process"
import { createMerakCodeClient, type MerakCodeClient } from "@merakcode/sdk/client"
import { Log } from "@merakcode/log/logger"
import { Runtime } from "@merakcode/util/runtime"
import { UI } from "./ui"

export function engineCommand(): string[] {
  return [process.execPath, ...Runtime.execArgv(), path.resolve(process.argv[1]!)]
}

const NETWORK = ["--port", "--hostname", "--mdns", "--mdns-domain", "--cors"]

/**
 * Network flags given explicitly on the command line are passed to serve as-is; the rest come from the config file,
 * as with `merak serve`. Without any, serve listens on a random localhost port.
 */
export function serveArgs(argv = process.argv): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const name = arg.split("=")[0]!
    if (!NETWORK.includes(name.replace(/^--no-/, "--"))) continue
    out.push(arg)
    const next = argv[i + 1]
    if (!arg.includes("=") && next !== undefined && !next.startsWith("-") && name !== "--mdns") out.push(argv[++i]!)
  }
  if (!out.some((arg) => arg.startsWith("--hostname"))) out.push("--hostname", "127.0.0.1")
  if (!out.some((arg) => arg.startsWith("--port"))) out.push("--port", "0")
  return out
}

export function launchEngine(input: {
  cwd: string
  client: string
  env?: Record<string, string | undefined>
  serve?: string[]
}): Promise<Engine> {
  return startEngine({
    cwd: input.cwd,
    executablePath: engineCommand(),
    serve: input.serve ?? serveArgs(),
    env: { ...input.env, MERAKCODE_CLIENT: input.client },
  })
}

/**
 * Management subcommands (session, mcp, provider, etc.) are SDK clients too: start the engine, do the work, shut it
 * down. Exits with an error if the engine fails to start.
 */
export async function withEngine<T>(fn: (sdk: MerakCodeClient) => Promise<T>): Promise<T> {
  const cwd = process.cwd()
  const engine = await launchEngine({ cwd, client: "cli" }).catch((error: Error) => {
    UI.error(error.message)
    process.exit(1)
  })
  try {
    return await fn(
      createMerakCodeClient({ baseUrl: engine.url, headers: engine.headers, directory: cwd, clientRun: Log.id() }),
    )
  } finally {
    await engine.close()
  }
}
