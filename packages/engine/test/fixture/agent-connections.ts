import { Filesystem } from "@merakcode/util/filesystem"
import { globalConfigFile } from "@merakcode/util/paths"
import { Config } from "../../src/config/config"

/** Installs isolated global connection fixtures without probing real coding CLIs. */
export async function configureConnections(products: Record<string, Config.AgentConnectionProduct>) {
  await Filesystem.write(
    globalConfigFile(),
    JSON.stringify({
      $schema: Config.SCHEMA,
      agentConnections: {
        products: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false }, ...products },
      },
    }),
  )
  Config.invalidateScope("global")
}
