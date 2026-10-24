/**
 * The member adapters MerakCode ships: each is its own program speaking the member protocol, started for one task.
 * A release runs the bundled adapter-<name>.js next to the engine; a source checkout runs the TypeScript with the
 * development loader, as the Linux sandbox helper does.
 */
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Product } from "@merakcode/sdk/adapter"
import { Runtime } from "@merakcode/util/runtime"
import { whichInstalled } from "../locate"

const BUILTIN_ADAPTERS = ["claude", "codex", "opencode", "command"] as const
type BuiltinAdapter = (typeof BUILTIN_ADAPTERS)[number]

const isBuiltinAdapter = (name?: string): name is BuiltinAdapter => BUILTIN_ADAPTERS.includes(name as BuiltinAdapter)

/**
 * How a product starts, and what its adapter is told about it; undefined when its command is not on this machine.
 * For a built-in adapter command and args are the CLI and extra arguments for it (a product without an adapter is a
 * one-shot command); for member they start the user's own adapter. The command is passed found, so an adapter does
 * not have to look in the places a CLI is often installed outside PATH.
 */
export function adapterOf(product: {
  id: string
  title: string
  command: string
  args: string[]
  resumeArgs?: string[]
  sessionLine?: string
  adapter?: string
}): { launch: string[]; product: Product } | undefined {
  const command = located(product.command)
  if (!command) return undefined
  if (product.adapter === "member")
    return { launch: [command, ...product.args], product: { id: product.id, title: product.title } }
  const name = isBuiltinAdapter(product.adapter) ? product.adapter : "command"
  const { id, title, args, resumeArgs, sessionLine } = product
  return { launch: builtinLaunch(name), product: { id, title, command, args, resumeArgs, sessionLine } }
}

/** A command's full path on this machine; node is the Node MerakCode runs on, which every install has */
function located(command: string) {
  if (command === "node") return process.execPath
  return whichInstalled(command)
}

/** The command line that starts a built-in adapter */
export function builtinLaunch(name: BuiltinAdapter, here = import.meta.url, execArgv = Runtime.execArgv()): string[] {
  const bundled = fileURLToPath(new URL(`./adapter-${name}.js`, here))
  if (existsSync(bundled)) return [process.execPath, "--disable-warning=ExperimentalWarning", bundled]
  return [
    process.execPath,
    ...execArgv,
    "--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL(`./${name}.ts`, here)),
  ]
}
