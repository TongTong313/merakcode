/**
 * merak bug-report: zips the doctor results, recent logs and config (secrets removed) for a GitHub issue.
 */
import type { Argv } from "yargs"
import { EOL } from "os"
import path from "path"
import { createBundle } from "@merakcode/log/bundle"
import { resolveLogRoot } from "@merakcode/log/node"
import { readConfigFile } from "@merakcode/util/config-peek"
import { globalConfigFile } from "@merakcode/util/paths"
import { Project } from "@merakcode/util/project"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { I18n } from "../i18n"
import { Doctor } from "../doctor"

const stamp = () =>
  new Date()
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replaceAll(/[-:]/g, "")
    .replace("T", "-")

export const BugReportCommand = cmd({
  command: "bug-report",
  describe: I18n.t("cli.bugReport.describe"),
  builder: (yargs: Argv) =>
    yargs
      .option("out", { describe: I18n.t("cli.bugReport.out"), type: "string" })
      .option("network", { describe: I18n.t("cli.doctor.network"), type: "boolean" }),
  handler: async (args) => {
    const cwd = process.cwd()
    UI.println(UI.Style.TEXT_DIM + I18n.t("cli.bugReport.checking") + UI.Style.TEXT_NORMAL)
    const checks = await Doctor.run({ cwd, network: args.network })
    const configs = {
      "config/global.json": readConfigFile(globalConfigFile()),
      "config/project.json": readConfigFile(path.join(cwd, "merakcode.json")),
      "config/project.jsonc": readConfigFile(path.join(cwd, "merakcode.jsonc")),
      "config/project-dir.json": readConfigFile(path.join(cwd, ".merakcode", "merakcode.json")),
      "config/project-dir.jsonc": readConfigFile(path.join(cwd, ".merakcode", "merakcode.jsonc")),
    }
    const { file } = await createBundle({
      root: resolveLogRoot(),
      out: path.resolve(args.out ?? `merakcode-report-${stamp()}.zip`),
      extra: {
        "doctor.json": checks,
        ...Object.fromEntries(Object.entries(configs).filter(([, value]) => value !== undefined)),
      },
    })
    process.stdout.write(I18n.t("cli.bugReport.saved", { file }) + EOL)
    process.stdout.write(I18n.t("cli.bugReport.next") + EOL)
    process.stdout.write(`${Project.ISSUES}/new?template=bug_report.yml${EOL}`)
  },
})
