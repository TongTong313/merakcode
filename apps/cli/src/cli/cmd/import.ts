import type { Argv } from "yargs"
import type { MerakCodeClient } from "@merakcode/sdk/client"
import { cmd } from "./cmd"
import { withEngine } from "../engine"
import { I18n } from "../i18n"
import { EOL } from "os"
import { Filesystem } from "@merakcode/util/filesystem"

type Exported = Parameters<MerakCodeClient["session"]["importFull"]>[0]

export const ImportCommand = cmd({
  command: "import <file>",
  describe: I18n.t("cli.import.describe"),
  builder: (yargs: Argv) => {
    return yargs.positional("file", {
      describe: I18n.t("cli.import.file"),
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    const data = (await Filesystem.readJson(args.file).catch(() => undefined)) as Partial<Exported> | undefined
    const fail = (message: string) => {
      process.stdout.write(message + EOL)
      process.exitCode = 1
    }
    if (!data) return fail(I18n.t("cli.import.fileNotFound", { path: args.file }))
    const { info, messages } = data
    if (!info || !messages) return fail(I18n.t("cli.import.invalid"))

    // Imports into the current project. The engine assigns new IDs to the session and messages, so importing a file
    // twice creates two sessions; the engine rejects malformed input.
    const imported = await withEngine((sdk) => sdk.session.importFull({ info, messages }).then((x) => x.data))
    if (!imported) return fail(I18n.t("cli.import.invalid"))
    process.stdout.write(I18n.t("cli.import.done", { session: imported.info.id }) + EOL)
  },
})
