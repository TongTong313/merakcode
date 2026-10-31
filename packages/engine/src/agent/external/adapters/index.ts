/**
 * The member adapters MerakCode ships: each is its own program speaking the member protocol, started for one task.
 * A release runs the bundled adapter-<name>.js next to the engine; a source checkout runs the TypeScript with the
 * development loader, as the Linux sandbox helper does.
 */
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Product, ProductModel } from "@merakcode/sdk/adapter"
import { Runtime } from "@merakcode/util/runtime"
import { whichInstalled } from "../locate"
import { Config } from "@merakcode/engine/agent/settings/index"
import { Text } from "../../prompt/text"

const BUILTIN_ADAPTERS = ["claude", "codex", "opencode", "command"] as const
type BuiltinAdapter = (typeof BUILTIN_ADAPTERS)[number]

const isBuiltinAdapter = (name?: string): name is BuiltinAdapter => BUILTIN_ADAPTERS.includes(name as BuiltinAdapter)

export function conflictingArgument(adapter: string, args: readonly string[]) {
  if (!["claude", "codex", "opencode"].includes(adapter)) return undefined
  const flags = ["--model", "-m", "--output-format", "--input-format", "--include-partial-messages"]
  if (adapter === "claude")
    flags.push(
      "-p",
      "--print",
      "--permission-mode",
      "--permission-prompt-tool",
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
      "--resume",
      "-r",
      "--session-id",
      "--continue",
      "-c",
    )
  if (adapter === "codex")
    flags.push(
      "--sandbox",
      "-s",
      "--ask-for-approval",
      "-a",
      "--dangerously-bypass-approvals-and-sandbox",
      "--yolo",
      "--full-auto",
      "--listen",
    )
  if (adapter === "opencode") flags.push("--hostname", "--port", "--mdns", "--cors")
  for (const [index, arg] of args.entries()) {
    if (
      flags.some(
        (flag) =>
          arg === flag || arg.startsWith(`${flag}=`) || (flag.length === 2 && arg.startsWith(flag) && arg.length > 2),
      )
    )
      return arg
    if (adapter !== "codex") continue
    const config =
      arg === "-c" || arg === "--config"
        ? args[index + 1]
        : arg.startsWith("--config=")
          ? arg.slice(9)
          : arg.startsWith("-c")
            ? arg.slice(2)
            : undefined
    if (
      config &&
      /^\s*(?:model(?:_provider)?|approval_policy|sandbox_mode|sandbox_workspace_write(?:\.[\w_]+)?|permissions(?:\.[\w_]+)?)\s*=/.test(
        config,
      )
    )
      return arg
  }
}

/**
 * How a product starts, and what its adapter is told about it; undefined when its command is not on this machine.
 * For a built-in adapter command and args are the CLI and extra arguments for it (a product without an adapter is a
 * one-shot command); for member they start the user's own adapter. The command is passed found, so an adapter does
 * not have to look in the places a CLI is often installed outside PATH.
 */
export async function adapterOf(product: {
  id: string
  title: string
  command: string
  args: string[]
  resumeArgs?: string[]
  sessionLine?: string
  adapter?: string
  model?: ProductModel
}): Promise<{ launch: string[]; product: Product } | undefined> {
  const conflict = conflictingArgument(product.adapter ?? "command", product.args)
  if (conflict)
    throw new Config.InvalidError({
      path: `agentConnections.products.${product.id}.args`,
      message: await Text.pick(
        {
          zh: "额外参数不能覆盖模型、适配器协议或权限设置：{argument}",
          en: "Extra arguments cannot override the model, protocol, or permission settings: {argument}",
        },
        { argument: conflict },
      ),
    })
  if ((product.adapter ?? "command") === "command") {
    const templates = [product.args, ...(product.resumeArgs ? [product.resumeArgs] : [])]
    if (templates.some((args) => !!product.model !== args.includes("{model}")))
      throw new Config.InvalidError({
        path: `agentConnections.products.${product.id}.model`,
        message: await Text.pick({
          zh: "模型配置必须与首次及续接参数中的 {model} 占位符一致",
          en: "The model setting must match the {model} placeholder in initial and resume arguments",
        }),
      })
  }
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
