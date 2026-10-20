import path from "path"
import * as prompts from "@clack/prompts"
import type { MerakCodeClient } from "@merakcode/sdk/client"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { I18n } from "../i18n"
import { withEngine } from "../engine"

/** Lists installable skills from a source (owner/repo or URL); the engine returns 400 for an unrecognized source. */
async function available(sdk: MerakCodeClient, source: string) {
  const result = await sdk.skillInstall.list({ source })
  if (result.data) return result.data
  if (result.response?.status === 400) return "invalid" as const
  throw new Error(JSON.stringify(result.error))
}

export const SkillCommand = cmd({
  command: "skill",
  describe: I18n.t("cli.skill.describe"),
  builder: (yargs) => yargs.command(SkillInstallCommand).command(SkillListCommand).demandCommand(),
  async handler() {},
})

export const SkillInstallCommand = cmd({
  command: "install [source]",
  describe: I18n.t("cli.skill.install.describe"),
  builder: (yargs) =>
    yargs
      .positional("source", {
        describe: I18n.t("cli.skill.option.source"),
        type: "string",
      })
      .option("name", {
        describe: I18n.t("cli.skill.install.name"),
        type: "string",
      })
      .option("global", {
        describe: I18n.t("cli.skill.install.global"),
        type: "boolean",
        default: false,
      }),
  async handler(args) {
    await withEngine(async (sdk) => {
      UI.empty()
      prompts.intro(I18n.t("cli.skill.install.title"))

      const promptSource = async () => {
        const input = await prompts.text({
          message: I18n.t("skills.remote.source"),
          placeholder: I18n.t("cli.skill.install.sourcePlaceholder"),
          validate: (x) => (x && x.trim().length > 0 ? undefined : I18n.t("cli.skill.install.required")),
        })
        if (prompts.isCancel(input)) throw new UI.CancelledError()
        return input.trim()
      }
      const sourceInput = args.source?.trim() || (await promptSource())

      const spinner = prompts.spinner()
      spinner.start(I18n.t("cli.skill.install.fetching"))
      const listed = await available(sdk, sourceInput).catch((err: unknown) => {
        spinner.error(String(err instanceof Error ? err.message : err))
        process.exit(1)
      })
      if (listed === "invalid") {
        spinner.stop()
        prompts.log.error(I18n.t("cli.skill.invalidSource"))
        prompts.outro(I18n.t("cli.skill.install.example"))
        process.exit(1)
      }
      const skills = listed.skills
      spinner.stop(I18n.t("cli.skill.install.found", { count: skills.length }))

      if (skills.length === 0) {
        prompts.log.warn(I18n.t("skills.remoteMarket.emptyResult"))
        prompts.outro("")
        return
      }

      let selected: typeof skills
      if (args.name) {
        const found = skills.filter((s) => s.name === args.name)
        if (found.length === 0) {
          prompts.log.error(I18n.t("cli.skill.install.notFound", { name: args.name }))
          process.exit(1)
        }
        selected = found
      } else {
        const result = await prompts.multiselect({
          message: I18n.t("cli.skill.install.select"),
          options: skills.map((s) => ({
            label: s.name,
            value: s,
            hint: s.description?.slice(0, 50) + (s.description && s.description.length > 50 ? "..." : ""),
          })),
        })
        if (prompts.isCancel(result)) throw new UI.CancelledError()
        selected = result
      }

      const paths = await sdk.path.get(undefined, { throwOnError: true }).then((x) => x.data)
      const dirs = {
        project: path.join(paths.directory, ".merakcode", "skills"),
        global: path.join(paths.config, "skills"),
      }
      let target: "project" | "global"
      if (args.global) {
        target = "global"
      } else {
        const scopeResult = await prompts.select({
          message: I18n.t("skills.remote.target"),
          options: [
            {
              label: I18n.t("common.currentProject"),
              value: "project" as const,
              hint: dirs.project + path.sep,
            },
            {
              label: I18n.t("skills.location.global"),
              value: "global" as const,
              hint: dirs.global + path.sep,
            },
          ],
        })
        if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
        target = scopeResult
      }

      spinner.start(I18n.t("cli.skill.install.installing"))
      const { installed, failed } = await sdk.skillInstall
        .install({ source: listed.source, skills: selected, target }, { throwOnError: true })
        .then((x) => x.data)
      spinner.stop(I18n.t("cli.skill.install.installed", { count: installed.length }))

      for (const name of installed) {
        prompts.log.success(`${name} → ${path.join(dirs[target], name)}${path.sep}`)
      }
      for (const { name, error } of failed) {
        prompts.log.error(`${name}: ${error}`)
      }

      prompts.outro(I18n.t("skills.remote.hint"))
    })
  },
})

export const SkillListCommand = cmd({
  command: "list <source>",
  describe: I18n.t("cli.skill.list.describe"),
  builder: (yargs) =>
    yargs.positional("source", {
      describe: I18n.t("cli.skill.option.source"),
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    const listed = await withEngine((sdk) => available(sdk, args.source))
    if (listed === "invalid") {
      console.error(I18n.t("cli.skill.invalidSource"))
      process.exit(1)
    }
    for (const s of listed.skills) {
      console.log(`${s.name}\t${s.description?.replace(/\s+/g, " ").slice(0, 60) ?? ""}`)
    }
  },
})
