import { cmd } from "../cmd"
import { host } from "./host"
import { I18n } from "../../i18n"

export const ConfigCommand = cmd({
  command: "config",
  describe: I18n.t("cli.debug.config"),
  builder: (yargs) => yargs,
  async handler() {
    const m = await (await host()).debug.config()
    return m.run()
  },
})
