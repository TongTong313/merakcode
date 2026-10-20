import { cmd } from "../cmd"
import { host } from "./host"
import { I18n } from "../../i18n"

export const AgentCommand = cmd({
  command: "agent <id>",
  describe: I18n.t("cli.debug.agent"),
  builder: (yargs) =>
    yargs
      .positional("id", {
        type: "string",
        demandOption: true,
        description: I18n.t("cli.debug.agentId"),
      })
      .option("tool", {
        type: "string",
        description: I18n.t("cli.debug.tool"),
      })
      .option("params", {
        type: "string",
        description: I18n.t("cli.debug.params"),
      }),
  async handler(args) {
    const m = await (await host()).debug.agent()
    return m.run(args)
  },
})
