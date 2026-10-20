import type { Argv } from "yargs"
import { withEngine } from "../engine"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { I18n } from "../i18n"
import { EOL } from "os"

export const ModelsCommand = cmd({
  command: "models [provider]",
  describe: I18n.t("cli.models.describe"),
  builder: (yargs: Argv) => {
    return yargs
      .positional("provider", {
        describe: I18n.t("cli.models.provider"),
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: I18n.t("cli.models.verbose"),
        type: "boolean",
      })
      .option("refresh", {
        describe: I18n.t("cli.models.refresh"),
        type: "boolean",
      })
  },
  handler: async (args) => {
    const providers = await withEngine(async (sdk) => {
      if (args.refresh) {
        const refreshed = await sdk.provider.catalog.refresh(undefined, { throwOnError: true }).then((x) => x.data)
        if (refreshed) UI.println(UI.Style.TEXT_SUCCESS_BOLD + I18n.t("cli.models.refreshed") + UI.Style.TEXT_NORMAL)
        else UI.error(I18n.t("cli.models.refreshFailed"))
      }
      return sdk.config.providers(undefined, { throwOnError: true }).then((x) => x.data.providers)
    })

    const selected = args.provider ? providers.filter((provider) => provider.id === args.provider) : providers
    if (args.provider && selected.length === 0) {
      UI.error(I18n.t("cli.models.providerNotFound", { provider: args.provider }))
      return
    }
    for (const provider of selected.toSorted((a, b) => a.id.localeCompare(b.id))) {
      for (const [modelID, model] of Object.entries(provider.models).sort(([a], [b]) => a.localeCompare(b))) {
        process.stdout.write(`${provider.id}/${modelID}`)
        process.stdout.write(EOL)
        if (args.verbose) {
          process.stdout.write(JSON.stringify(model, null, 2))
          process.stdout.write(EOL)
        }
      }
    }
  },
})
