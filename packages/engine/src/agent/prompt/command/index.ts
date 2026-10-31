import { BusEvent } from "../../../infra/bus/bus-event"
import z from "zod"
import { Config } from "@merakcode/engine/agent/settings/index"
import { Instance } from "../../../infra/project/instance"
import { Identifier } from "@merakcode/util/id"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { MCP } from "../../mcp"
import { Skill } from "../../skill"
import { Text } from "../text"

export namespace Command {
  let applicationCommands: () => Promise<Info[]> = async () => []

  export function useCommands(provider: () => Promise<Info[]>) {
    applicationCommands = provider
  }

  export const Event = {
    Executed: BusEvent.define(
      "command.executed",
      z.object({
        name: z.string(),
        sessionID: Identifier.schema("session"),
        arguments: z.string(),
        messageID: Identifier.schema("message"),
      }),
    ),
  }

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      source: z.enum(["command", "mcp", "skill"]).optional(),
      handler: z.enum(["context"]).optional(),
      // workaround for zod not supporting async functions natively so we use getters
      // https://zod.dev/v4/changelog?id=zfunction
      template: z.promise(z.string()).or(z.string()),
      subtask: z.boolean().optional(),
      hints: z.array(z.string()),
    })
    .meta({
      ref: "Command",
    })

  // for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
  export type Info = Omit<z.infer<typeof Info>, "template"> & { template: Promise<string> | string }

  export function hints(template: string): string[] {
    const result: string[] = []
    const numbered = template.match(/\$\d+/g)
    if (numbered) {
      for (const match of [...new Set(numbered)].sort()) result.push(match)
    }
    if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
    return result
  }

  export const Default = {
    INIT: "init",
    REVIEW: "review",
    CONTEXT: "context",
  } as const

  export const state = Instance.state(async () => {
    const cfg = await Config.get()
    // Built-in command descriptions appear in the command palette, so they follow the UI language (Chinese when no
    // locale is configured)
    const lang = await Text.lang()
    const descriptions = {
      init: { zh: "创建/更新 AGENTS.md", en: "Create/update AGENTS.md" },
      review: {
        zh: "审查变更 [commit|branch|pr]，默认未提交",
        en: "Review changes [commit|branch|pr], default uncommitted",
      },
      context: {
        zh: "查看当前上下文窗口、统计和 tool result 预算",
        en: "Show current context window, stats, and tool result budget",
      },
    } satisfies Record<string, Text.Pair>
    const t = (key: keyof typeof descriptions) => Text.format(descriptions[key], lang)

    const result: Record<string, Info> = {
      [Default.INIT]: {
        name: Default.INIT,
        description: t("init"),
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", Instance.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      },
      [Default.REVIEW]: {
        name: Default.REVIEW,
        description: t("review"),
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", Instance.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      },
      [Default.CONTEXT]: {
        name: Default.CONTEXT,
        description: t("context"),
        source: "command",
        handler: "context",
        template: "",
        hints: [],
      },
    }

    for (const [name, command] of Object.entries(cfg.command ?? {})) {
      result[name] = {
        name,
        agent: command.agent,
        model: command.model,
        description: command.description,
        source: "command",
        get template() {
          return command.template
        },
        subtask: command.subtask,
        hints: hints(command.template),
      }
    }

    for (const command of await applicationCommands()) {
      if (!result[command.name]) result[command.name] = command
    }

    for (const [name, prompt] of Object.entries(await MCP.prompts())) {
      result[name] = {
        name,
        source: "mcp",
        description: prompt.description,
        get template() {
          return MCP.getPrompt(
            prompt.client,
            prompt.name,
            prompt.arguments
              ? // substitute each argument with $1, $2, etc.
                Object.fromEntries(prompt.arguments?.map((argument, i) => [argument.name, `$${i + 1}`]))
              : {},
          ).then((template) =>
            template.messages
              .map((message) => (message.content.type === "text" ? message.content.text : ""))
              .join("\n"),
          )
        },
        hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
      }
    }

    // Add skills as invokable commands
    for (const skill of await Skill.all()) {
      // Skip if a command with this name already exists
      if (result[skill.name]) continue
      result[skill.name] = {
        name: skill.name,
        description: skill.description,
        source: "skill",
        get template() {
          // Return a short user message; the skill content is passed through the system parameter
          return `/${skill.name}`
        },
        hints: [],
      }
    }

    return result
  })

  const dependencies = Instance.state(() => ({ config: undefined as Config.Info | undefined, mcp: -1 }))

  async function catalog() {
    // ConfigWatch invalidates Config independently of the Instance. Reusing the
    // command snapshot would otherwise keep old templates in a long-lived Worker.
    const config = await Config.get()
    const previous = dependencies()
    const mcp = MCP.commandVersion()
    if (previous.config !== config || previous.mcp !== mcp) {
      state.invalidate()
      previous.config = config
      previous.mcp = mcp
    }
    return state()
  }

  export async function get(name: string) {
    return catalog().then((x) => x[name])
  }

  export async function list() {
    return catalog().then((x) => Object.values(x))
  }
}
