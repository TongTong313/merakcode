import type { Argv } from "yargs"
import { EOL } from "os"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { I18n } from "../i18n"
import { Doctor } from "../doctor"

const MARK: Record<Doctor.Status, string> = {
  pass: UI.Style.TEXT_SUCCESS_BOLD + "✓" + UI.Style.TEXT_NORMAL,
  warn: UI.Style.TEXT_WARNING_BOLD + "!" + UI.Style.TEXT_NORMAL,
  fail: UI.Style.TEXT_DANGER_BOLD + "✗" + UI.Style.TEXT_NORMAL,
  skip: UI.Style.TEXT_DIM + "-" + UI.Style.TEXT_NORMAL,
}

export const DoctorCommand = cmd({
  command: "doctor",
  describe: I18n.t("cli.doctor.describe"),
  builder: (yargs: Argv) =>
    yargs
      .option("network", { describe: I18n.t("cli.doctor.network"), type: "boolean" })
      .option("json", { describe: I18n.t("cli.doctor.json"), type: "boolean" }),
  handler: async (args) => {
    const checks = await Doctor.run({ cwd: process.cwd(), network: args.network })
    const failed = checks.filter((check) => check.status === "fail").length
    if (failed) process.exitCode = 1
    if (args.json) {
      process.stdout.write(JSON.stringify(checks, null, 2) + EOL)
      return
    }
    for (const check of checks) {
      const name = I18n.t(`cli.doctor.check.${check.id}`)
      // CJK characters take two columns in a terminal
      const width = [...name].reduce((sum, char) => sum + (char.charCodeAt(0) >= 0x2e80 ? 2 : 1), 0)
      const title = name + " ".repeat(Math.max(1, 10 - width))
      const detail = [check.code && `[${check.code}]`, check.detail].filter(Boolean).join(" ")
      process.stdout.write(`  ${MARK[check.status]} ${title} ${detail}${EOL}`)
      if (check.hint && check.status !== "pass") process.stdout.write(`    ${" ".repeat(11)}${check.hint}${EOL}`)
    }
    process.stdout.write(
      EOL + (failed ? I18n.t("cli.doctor.failed", { count: failed }) : I18n.t("cli.doctor.ok")) + EOL,
    )
  },
})
