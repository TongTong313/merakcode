import { cmd } from "../cmd"
import { host } from "./host"
import { I18n } from "../../i18n"

export const SkillCommand = cmd({
  command: "skill",
  describe: I18n.t("cli.debug.skill"),
  builder: (yargs) => yargs,
  async handler() {
    const m = await (await host()).debug.skill()
    return m.run()
  },
})
