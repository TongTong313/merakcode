/**
 * merak upgrade [target] (also merak update): installs the newest version, or the one given.
 * --check only shows the versions; without a terminal it only checks unless --yes is given.
 */
import type { Argv } from "yargs"
import semver from "semver"
import * as prompts from "@clack/prompts"
import { Project } from "@merakcode/util/project"
import { UI } from "../ui"
import { I18n } from "../i18n"
import { Installation } from "../installation"
import { newer } from "../upgrade"
import { cmd } from "./cmd"

export const UpgradeCommand = cmd({
  command: "upgrade [target]",
  aliases: ["update"],
  describe: I18n.t("cli.upgrade.describe"),
  builder: (yargs: Argv) =>
    yargs
      .positional("target", { describe: I18n.t("cli.upgrade.version"), type: "string" })
      .option("check", { describe: I18n.t("cli.upgrade.check"), type: "boolean" })
      .option("yes", { alias: "y", describe: I18n.t("cli.upgrade.yes"), type: "boolean" })
      .option("method", { describe: I18n.t("cli.upgrade.method"), type: "string", choices: ["npm", "release"] }),
  handler: async (args) => {
    const wanted = args.target?.replace(/^v/, "")
    if (wanted !== undefined && !semver.valid(wanted)) {
      UI.error(I18n.t("cli.upgrade.invalid", { version: args.target }))
      process.exitCode = 1
      return
    }
    UI.empty()
    prompts.intro(I18n.t("cli.upgrade.title"))
    const method = (args.method as Installation.Method | undefined) ?? Installation.method()
    const target =
      wanted ??
      (await Installation.latest(method).catch((error: unknown) => {
        if (error instanceof Installation.NoReleaseError) {
          prompts.log.info(I18n.t("cli.upgrade.noRelease", { track: error.track }))
          return
        }
        prompts.log.error(
          I18n.t("cli.upgrade.fetchFailed", { error: error instanceof Error ? error.message : String(error) }),
        )
        process.exitCode = 1
      }))
    if (!target) return prompts.outro(I18n.t(process.exitCode ? "cli.upgrade.exited" : "cli.upgrade.upToDate"))

    prompts.log.info(I18n.t("cli.upgrade.versions", { current: Installation.VERSION, latest: target }))
    const downgrade = wanted !== undefined && newer(Installation.VERSION, target)
    if (target === Installation.VERSION || (!wanted && !newer(target, Installation.VERSION)))
      return prompts.outro(I18n.t("cli.upgrade.upToDate"))

    // Only look: asked to, or no terminal to confirm in
    const interactive = process.stdin.isTTY && process.stdout.isTTY
    if (args.check || (!interactive && !args.yes)) {
      prompts.log.info(I18n.t("cli.upgrade.available", { version: target }))
      return prompts.outro(I18n.t(args.check ? "cli.upgrade.hintInstall" : "cli.upgrade.hintYes"))
    }

    if (method === "unknown") {
      prompts.log.info(I18n.t("cli.upgrade.manual", { url: Project.RELEASES }))
      return prompts.outro(I18n.t("cli.upgrade.done"))
    }

    if (!args.yes) {
      const confirmed = await prompts.confirm({
        message: downgrade
          ? I18n.t("cli.upgrade.confirmDowngrade", { version: target, current: Installation.VERSION })
          : method === "npm"
            ? I18n.t("cli.upgrade.confirmNpm", { version: target })
            : I18n.t("cli.upgrade.confirm", { version: target }),
        initialValue: !downgrade,
      })
      if (!confirmed || prompts.isCancel(confirmed)) return prompts.outro(I18n.t("cli.upgrade.cancelled"))
    }

    const spinner = prompts.spinner()
    spinner.start(I18n.t("cli.upgrade.upgrading"))
    const failed = await Installation.upgrade(method, target).then(
      () => undefined,
      (error: unknown) => error,
    )
    if (failed) {
      spinner.error(I18n.t("cli.upgrade.failed"))
      prompts.log.error(failed instanceof Error ? failed.message : String(failed))
      process.exitCode = 1
      return prompts.outro(I18n.t("cli.upgrade.exited"))
    }
    spinner.stop(I18n.t("cli.upgrade.success", { version: target }))
    prompts.outro(I18n.t("cli.upgrade.done"))
  },
})
