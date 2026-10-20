import { cmd } from "../cmd"
import { host } from "./host"
import { I18n } from "../../i18n"

const FileSearchCommand = cmd({
  command: "search <query>",
  describe: I18n.t("cli.debug.fileSearch"),
  builder: (yargs) =>
    yargs.positional("query", {
      type: "string",
      demandOption: true,
      description: I18n.t("cli.debug.query"),
    }),
  async handler(args) {
    const m = await (await host()).debug.file()
    return m.search(args)
  },
})

const FileReadCommand = cmd({
  command: "read <path>",
  describe: I18n.t("cli.debug.fileRead"),
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      demandOption: true,
      description: I18n.t("cli.debug.readPath"),
    }),
  async handler(args) {
    const m = await (await host()).debug.file()
    return m.read(args)
  },
})

const FileStatusCommand = cmd({
  command: "status",
  describe: I18n.t("cli.debug.fileStatus"),
  builder: (yargs) => yargs,
  async handler() {
    const m = await (await host()).debug.file()
    return m.status()
  },
})

const FileListCommand = cmd({
  command: "list <path>",
  describe: I18n.t("cli.debug.fileList"),
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      demandOption: true,
      description: I18n.t("cli.debug.listPath"),
    }),
  async handler(args) {
    const m = await (await host()).debug.file()
    return m.list(args)
  },
})

const FileTreeCommand = cmd({
  command: "tree [dir]",
  describe: I18n.t("cli.debug.fileTree"),
  builder: (yargs) =>
    yargs.positional("dir", {
      type: "string",
      description: I18n.t("cli.debug.treeDir"),
      default: process.cwd(),
    }),
  async handler(args) {
    const m = await (await host()).debug.file()
    return m.tree(args)
  },
})

export const FileCommand = cmd({
  command: "file",
  describe: I18n.t("cli.debug.file"),
  builder: (yargs) =>
    yargs
      .command(FileReadCommand)
      .command(FileStatusCommand)
      .command(FileListCommand)
      .command(FileSearchCommand)
      .command(FileTreeCommand)
      .demandCommand(),
  async handler() {},
})
