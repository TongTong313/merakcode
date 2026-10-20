import { EOL } from "os"
import { cmd } from "../cmd"
import { I18n } from "../../i18n"

// Prints performance.now(): milliseconds from process start to this handler, i.e. the cost of resolving and
// evaluating all static imports.
export const StartupCommand = cmd({
  command: "startup",
  describe: I18n.t("cli.debug.startup"),
  builder: (yargs) => yargs,
  handler() {
    process.stdout.write(performance.now().toString() + EOL)
  },
})
