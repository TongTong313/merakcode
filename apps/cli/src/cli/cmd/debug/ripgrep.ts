import { cmd } from "../cmd"
import { host } from "./host"
import { I18n } from "../../i18n"

export const RipgrepCommand = cmd({
  command: "rg",
  describe: I18n.t("cli.debug.rg"),
  builder: (yargs) => yargs.command(TreeCommand).command(FilesCommand).command(SearchCommand).demandCommand(),
  async handler() {},
})

const TreeCommand = cmd({
  command: "tree",
  describe: I18n.t("cli.debug.rgTree"),
  builder: (yargs) =>
    yargs.option("limit", {
      type: "number",
    }),
  async handler(args) {
    const m = await (await host()).debug.ripgrep()
    return m.tree(args)
  },
})

const FilesCommand = cmd({
  command: "files",
  describe: I18n.t("cli.debug.rgFiles"),
  builder: (yargs) =>
    yargs
      .option("query", {
        type: "string",
        description: I18n.t("cli.debug.rgQuery"),
      })
      .option("glob", {
        type: "string",
        description: I18n.t("cli.debug.rgGlob"),
      })
      .option("limit", {
        type: "number",
        description: I18n.t("cli.debug.limit"),
      }),
  async handler(args) {
    const m = await (await host()).debug.ripgrep()
    return m.files(args)
  },
})

const SearchCommand = cmd({
  command: "search <pattern>",
  describe: I18n.t("cli.debug.rgSearch"),
  builder: (yargs) =>
    yargs
      .positional("pattern", {
        type: "string",
        demandOption: true,
        description: I18n.t("cli.debug.rgPattern"),
      })
      .option("glob", {
        type: "array",
        description: I18n.t("cli.debug.rgGlobs"),
      })
      .option("limit", {
        type: "number",
        description: I18n.t("cli.debug.limit"),
      }),
  async handler(args) {
    const m = await (await host()).debug.ripgrep()
    return m.search(args)
  },
})
