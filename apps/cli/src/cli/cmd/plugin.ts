import * as prompts from "@clack/prompts"
import { withEngine } from "../engine"
import { I18n } from "../i18n"
import { cmd } from "./cmd"

export const PluginCommand = cmd({
  command: "plugin",
  aliases: ["plugins"],
  describe: I18n.t("cli.plugin.describe"),
  builder: (yargs) =>
    yargs.command(PluginListCommand).command(PluginAddCommand).command(PluginRemoveCommand).demandCommand(),
  async handler() {},
})

export const PluginListCommand = cmd({
  command: "list",
  describe: I18n.t("cli.plugin.list.describe"),
  builder: (yargs) =>
    yargs.option("json", {
      describe: I18n.t("cli.option.json"),
      type: "boolean",
      default: false,
    }),
  async handler(args) {
    const plugins = await withEngine((sdk) => sdk.plugin.list(undefined, { throwOnError: true }).then((x) => x.data))
    if (args.json) {
      console.log(JSON.stringify(plugins, null, 2))
      return
    }
    for (const plugin of plugins) {
      const tools = plugin.tools.length ? `${plugin.tools.length} tools` : "no tools"
      const error = plugin.error ? ` — ${plugin.error}` : ""
      console.log(`${plugin.status.padEnd(8)} ${plugin.id} [${plugin.source}, ${tools}]${error}`)
    }
  },
})

export const PluginAddCommand = cmd({
  command: "add <specifier>",
  aliases: ["install"],
  describe: I18n.t("cli.plugin.add.describe"),
  builder: (yargs) =>
    yargs
      .positional("specifier", {
        describe: I18n.t("cli.plugin.add.specifier"),
        type: "string",
        demandOption: true,
      })
      .option("global", {
        describe: I18n.t("cli.plugin.add.global"),
        type: "boolean",
        default: false,
      }),
  async handler(args) {
    await withEngine((sdk) =>
      sdk.plugin.add({ specifier: args.specifier, scope: args.global ? "global" : "project" }, { throwOnError: true }),
    )
    prompts.log.success(I18n.t("cli.plugin.add.done", { name: args.specifier }))
    prompts.log.info(I18n.t("cli.plugin.add.hint"))
  },
})

export const PluginRemoveCommand = cmd({
  command: "remove <name>",
  aliases: ["uninstall"],
  describe: I18n.t("cli.plugin.remove.describe"),
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: I18n.t("cli.plugin.remove.name"),
        type: "string",
        demandOption: true,
      })
      .option("global", {
        describe: I18n.t("cli.plugin.remove.global"),
        type: "boolean",
        default: false,
      }),
  async handler(args) {
    const removed = await withEngine((sdk) =>
      sdk.plugin
        .remove({ name: args.name, scope: args.global ? "global" : "project" }, { throwOnError: true })
        .then((x) => x.data),
    )
    if (!removed) {
      prompts.log.warn(I18n.t("cli.plugin.remove.notFound", { name: args.name }))
      return
    }
    prompts.log.success(I18n.t("cli.plugin.remove.done", { name: args.name }))
  },
})
