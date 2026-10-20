// Loads the engine only when `serve` runs; every other command starts without it
import { cmd } from "./cmd"
import { I18n } from "../i18n"
import { withNetworkOptions } from "../network-options"
import { Exit, waitForShutdown } from "../shutdown"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: I18n.t("cli.serve.describe"),
  handler: async (args) => {
    const { EngineHost } = await import("@merakcode/engine/host")
    Exit.register(EngineHost.cleanup)
    await EngineHost.serve(args, { waitForShutdown })
  },
})
