import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { withEngine } from "../engine"
import { UI } from "../ui"
import { I18n } from "../i18n"
import * as prompts from "@clack/prompts"
import { EOL } from "os"

export const ExportCommand = cmd({
  command: "export [sessionID]",
  describe: I18n.t("cli.export.describe"),
  builder: (yargs: Argv) => {
    return yargs.positional("sessionID", {
      describe: I18n.t("cli.export.sessionID"),
      type: "string",
    })
  },
  handler: async (args) => {
    process.stderr.write(I18n.t("cli.export.exporting", { session: args.sessionID ?? I18n.t("cli.export.latest") }))
    const result = await withEngine(async (sdk) => {
      let sessionID = args.sessionID

      if (!sessionID) {
        UI.empty()
        prompts.intro(I18n.t("cli.export.intro"), {
          output: process.stderr,
        })

        const sessions = await sdk.session.list(undefined, { throwOnError: true }).then((x) => x.data)

        if (sessions.length === 0) {
          prompts.log.error(I18n.t("cli.export.none"), {
            output: process.stderr,
          })
          prompts.outro(I18n.t("cli.done"), {
            output: process.stderr,
          })
          return
        }

        sessions.sort((a, b) => b.time.updated - a.time.updated)

        const selectedSession = await prompts.autocomplete({
          message: I18n.t("cli.export.select"),
          maxItems: 10,
          options: sessions.map((session) => ({
            label: session.title,
            value: session.id,
            hint: `${new Date(session.time.updated).toLocaleString()} • ${session.id.slice(-8)}`,
          })),
          output: process.stderr,
        })

        if (prompts.isCancel(selectedSession)) {
          throw new UI.CancelledError()
        }

        sessionID = selectedSession as string

        prompts.outro(I18n.t("cli.export.running"), {
          output: process.stderr,
        })
      }

      const exported = await sdk.session.exportFull({ sessionID })
      return { sessionID, data: exported.data }
    })
    if (!result) return
    if (!result.data) {
      UI.error(I18n.t("cli.session.notFound", { session: result.sessionID }))
      process.exit(1)
    }
    process.stdout.write(JSON.stringify(result.data, null, 2))
    process.stdout.write(EOL)
  },
})
