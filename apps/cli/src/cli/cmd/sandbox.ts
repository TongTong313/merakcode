/**
 * merak sandbox status|setup|reset: the OS sandbox for agent commands, through the engine (SDK).
 */
import type { Argv } from "yargs"
import { EOL } from "os"
import type { SandboxStatus } from "@merakcode/sdk/client"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { I18n } from "../i18n"
import { withEngine } from "../engine"

/** The engine's reason is technical English; a sandbox that only needs setup gets a translated line instead */
export function lines(status: SandboxStatus) {
  const head =
    status.status === "on"
      ? I18n.t("cli.sandbox.on", { backend: status.backend ?? "" })
      : status.status === "off"
        ? I18n.t("cli.sandbox.off")
        : status.installable
          ? I18n.t("cli.sandbox.notSetUp")
          : I18n.t("cli.sandbox.unavailable", { reason: status.reason ?? "" })
  return [
    head,
    ...(status.installable ? [I18n.t("cli.sandbox.installable")] : []),
    ...(status.degraded?.length
      ? [I18n.t("cli.sandbox.degraded"), ...status.degraded.map((item) => `  - ${I18n.t(`cli.sandbox.limit.${item}`)}`)]
      : []),
  ]
}

function print(status: SandboxStatus) {
  for (const line of lines(status)) process.stdout.write(line + EOL)
}

const StatusCommand = cmd({
  command: "status",
  describe: I18n.t("cli.sandbox.status"),
  builder: (yargs: Argv) => yargs.option("json", { describe: I18n.t("cli.doctor.json"), type: "boolean" }),
  handler: async (args) => {
    const status = await withEngine((sdk) => sdk.sandbox.status(undefined, { throwOnError: true }).then((x) => x.data))
    if (args.json) process.stdout.write(JSON.stringify(status, null, 2) + EOL)
    else print(status)
  },
})

const SetupCommand = cmd({
  command: "setup",
  describe: I18n.t("cli.sandbox.setup"),
  handler: async () => {
    UI.println(UI.Style.TEXT_DIM + I18n.t("cli.sandbox.settingUp") + UI.Style.TEXT_NORMAL)
    const status = await withEngine((sdk) => sdk.sandbox.install(undefined, { throwOnError: true }).then((x) => x.data))
    print(status)
    if (status.status !== "on") process.exitCode = 1
  },
})

const ResetCommand = cmd({
  command: "reset",
  describe: I18n.t("cli.sandbox.reset"),
  handler: async () => {
    UI.println(UI.Style.TEXT_DIM + I18n.t("cli.sandbox.resetting") + UI.Style.TEXT_NORMAL)
    const status = await withEngine((sdk) => sdk.sandbox.reset(undefined, { throwOnError: true }).then((x) => x.data))
    print(status)
  },
})

export const SandboxCommand = cmd({
  command: "sandbox",
  describe: I18n.t("cli.sandbox.describe"),
  builder: (yargs: Argv) => yargs.command(StatusCommand).command(SetupCommand).command(ResetCommand).demandCommand(),
  async handler() {},
})
