import { cmd } from "../cmd"
import { host } from "./host"
import { I18n } from "../../i18n"

export const ScrapCommand = cmd({
  command: "scrap",
  describe: I18n.t("cli.debug.scrap"),
  builder: (yargs) => yargs,
  async handler() {
    const m = await (await host()).debug.scrap()
    return m.run()
  },
})
