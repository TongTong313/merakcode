import { Paths } from "@merakcode/util/paths"
import { cmd } from "../cmd"
import { I18n } from "../../i18n"
import { ConfigCommand } from "./config"
import { FileCommand } from "./file"
import { LSPCommand } from "./lsp"
import { RipgrepCommand } from "./ripgrep"
import { ScrapCommand } from "./scrap"
import { SkillCommand } from "./skill"
import { SnapshotCommand } from "./snapshot"
import { AgentCommand } from "./agent"
import { ProcessCommand } from "./process"
import { StartupCommand } from "./startup"
import { host } from "./host"

export const DebugCommand = cmd({
  command: "debug",
  describe: I18n.t("cli.debug.describe"),
  builder: (yargs) =>
    yargs
      .command(ConfigCommand)
      .command(LSPCommand)
      .command(RipgrepCommand)
      .command(FileCommand)
      .command(ScrapCommand)
      .command(SkillCommand)
      .command(SnapshotCommand)
      .command(AgentCommand)
      .command(ProcessCommand)
      .command(StartupCommand)
      .command(PathsCommand)
      .command({
        command: "wait",
        describe: I18n.t("cli.debug.wait"),
        async handler() {
          await (
            await host()
          ).withInstance(process.cwd(), async () => {
            await new Promise((resolve) => setTimeout(resolve, 1_000 * 60 * 60 * 24))
          })
        },
      })
      .demandCommand(),
  async handler() {},
})

const PathsCommand = cmd({
  command: "paths",
  describe: I18n.t("cli.debug.paths"),
  handler() {
    for (const [key, value] of Object.entries(Paths)) {
      console.log(key.padEnd(10), value)
    }
  },
})
