import { withEngine } from "../engine"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { I18n } from "../i18n"
import path from "path"
import fs from "fs/promises"
import matter from "gray-matter"
import { EOL } from "os"
import type { Argv } from "yargs"
import { Filesystem } from "@merakcode/util/filesystem"
import { readableErrorText } from "@merakcode/util/error"
import { parseModel } from "@merakcode/util/model"

type AgentMode = "all" | "primary" | "subagent"

// Tools the user can pick when creating an agent. Internal protocol tools (todowrite, question, plan_*, etc.) are
// governed by INTERNAL_PERMISSION_KEYS and are not exposed here.
const AVAILABLE_TOOLS = ["bash", "read", "write", "edit", "ls", "glob", "grep", "webfetch"]

const AgentCreateCommand = cmd({
  command: "create",
  describe: I18n.t("cli.agent.create"),
  builder: (yargs: Argv) =>
    yargs
      .option("path", {
        type: "string",
        describe: I18n.t("cli.agent.path"),
      })
      .option("description", {
        type: "string",
        describe: I18n.t("cli.agent.description"),
      })
      .option("mode", {
        type: "string",
        describe: I18n.t("cli.agent.mode"),
        choices: ["all", "primary", "subagent"] as const,
      })
      .option("tools", {
        type: "string",
        describe: `comma-separated list of tools to enable (default: all). Available: "${AVAILABLE_TOOLS.join(", ")}"`,
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: I18n.t("app.option.model"),
      }),
  async handler(args) {
    await withEngine(async (sdk) => {
      const cliPath = args.path
      const cliDescription = args.description
      const cliMode = args.mode as AgentMode | undefined
      const cliTools = args.tools

      const isFullyNonInteractive = cliPath && cliDescription && cliMode && cliTools !== undefined

      if (!isFullyNonInteractive) {
        UI.empty()
        prompts.intro(I18n.t("cli.agent.intro"))
      }

      const [project, paths] = await Promise.all([
        sdk.project.current(undefined, { throwOnError: true }).then((x) => x.data),
        sdk.path.get(undefined, { throwOnError: true }).then((x) => x.data),
      ])

      // Determine scope/path
      let targetPath: string
      if (cliPath) {
        targetPath = path.join(cliPath, "agent")
      } else {
        let scope: "global" | "project" = "global"
        if (project.vcs === "git") {
          const scopeResult = await prompts.select({
            message: I18n.t("cli.agent.location"),
            options: [
              {
                label: "Current project",
                value: "project" as const,
                hint: paths.worktree,
              },
              {
                label: "Global",
                value: "global" as const,
                hint: paths.config,
              },
            ],
          })
          if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
          scope = scopeResult
        }
        targetPath = path.join(scope === "global" ? paths.config : path.join(paths.worktree, ".merakcode"), "agent")
      }

      // Get description
      let description: string
      if (cliDescription) {
        description = cliDescription
      } else {
        const query = await prompts.text({
          message: I18n.t("cli.agent.descriptionPrompt"),
          placeholder: I18n.t("cli.agent.purpose"),
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(query)) throw new UI.CancelledError()
        description = query
      }

      // When fully non-interactive (scripted), stdout carries only the file path and progress goes to stderr.
      const spinner = prompts.spinner(isFullyNonInteractive ? { output: process.stderr } : undefined)
      spinner.start(I18n.t("cli.agent.generating"))
      const model = args.model ? parseModel(args.model) : undefined
      const generated = await sdk.app
        .agentGenerate({ description, model }, { throwOnError: true })
        .then((x) => x.data)
        .catch((error: unknown) => {
          spinner.error(I18n.t("cli.agent.generateFailed", { error: readableErrorText(error, String(error)) }))
          if (isFullyNonInteractive) process.exit(1)
          throw new UI.CancelledError()
        })
      spinner.stop(I18n.t("cli.agent.generated", { name: generated.identifier }))

      // Select tools
      let selectedTools: string[]
      if (cliTools !== undefined) {
        selectedTools = cliTools ? cliTools.split(",").map((t) => t.trim()) : AVAILABLE_TOOLS
      } else {
        const result = await prompts.multiselect({
          message: I18n.t("cli.agent.tools"),
          options: AVAILABLE_TOOLS.map((tool) => ({
            label: tool,
            value: tool,
          })),
          initialValues: AVAILABLE_TOOLS,
        })
        if (prompts.isCancel(result)) throw new UI.CancelledError()
        selectedTools = result
      }

      // Get mode
      let mode: AgentMode
      if (cliMode) {
        mode = cliMode
      } else {
        const modeResult = await prompts.select({
          message: I18n.t("cli.agent.mode"),
          options: [
            {
              label: "All",
              value: "all" as const,
              hint: "Can function in both primary and subagent roles",
            },
            {
              label: "Primary",
              value: "primary" as const,
              hint: "Acts as a primary/main agent",
            },
            {
              label: "Subagent",
              value: "subagent" as const,
              hint: "Can be used as a subagent by other agents",
            },
          ],
          initialValue: "all" as const,
        })
        if (prompts.isCancel(modeResult)) throw new UI.CancelledError()
        mode = modeResult
      }

      // Build tools config
      const tools: Record<string, boolean> = {}
      for (const tool of AVAILABLE_TOOLS) {
        if (!selectedTools.includes(tool)) {
          tools[tool] = false
        }
      }

      // Build frontmatter
      const frontmatter: {
        description: string
        mode: AgentMode
        tools?: Record<string, boolean>
      } = {
        description: generated.whenToUse,
        mode,
      }
      if (Object.keys(tools).length > 0) {
        frontmatter.tools = tools
      }

      // Write file
      const content = matter.stringify(generated.systemPrompt, frontmatter)
      const filePath = path.join(targetPath, `${generated.identifier}.md`)

      await fs.mkdir(targetPath, { recursive: true })

      const file = filePath
      if (await Filesystem.isFile(file)) {
        if (isFullyNonInteractive) {
          console.error(I18n.t("cli.agent.exists", { path: filePath }))
          process.exit(1)
        }
        prompts.log.error(I18n.t("cli.agent.exists", { path: filePath }))
        throw new UI.CancelledError()
      }

      await Filesystem.write(filePath, content)

      if (isFullyNonInteractive) {
        console.log(filePath)
      } else {
        prompts.log.success(I18n.t("cli.agent.created", { path: filePath }))
        prompts.outro(I18n.t("cli.done"))
      }
    })
  },
})

const AgentListCommand = cmd({
  command: "list",
  describe: I18n.t("cli.agent.list"),
  async handler() {
    const agents = await withEngine((sdk) => sdk.app.agents(undefined, { throwOnError: true }).then((x) => x.data))
    const sortedAgents = agents.sort((a, b) => {
      if (a.native !== b.native) {
        return a.native ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    for (const agent of sortedAgents) {
      process.stdout.write(`${agent.name} (${agent.mode})` + EOL)
      process.stdout.write(`  ${JSON.stringify(agent.permission, null, 2)}` + EOL)
    }
  },
})

export const AgentCommand = cmd({
  command: "agent",
  describe: I18n.t("cli.agent.describe"),
  builder: (yargs) => yargs.command(AgentCreateCommand).command(AgentListCommand).demandCommand(),
  async handler() {},
})
