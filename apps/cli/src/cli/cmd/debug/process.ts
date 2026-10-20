import { cmd } from "../cmd"
import { host } from "./host"
import { I18n } from "../../i18n"

export const ProcessCommand = cmd({
  command: "process",
  describe: I18n.t("cli.debug.process"),
  async handler() {
    const m = await (await host()).debug.process()
    return m.run()
  },
})
