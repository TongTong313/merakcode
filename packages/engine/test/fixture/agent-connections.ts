import { parse as parseJsonc } from "jsonc-parser"
import { ConfigEdit } from "../../src/infra/config/edit"
import { Config } from "../../src/app/config/files/config"

/** Installs isolated global connection fixtures without probing real coding CLIs. */
export async function configureConnections(products: Record<string, Config.AgentConnectionProduct>) {
  // Merge under the config write lock so parallel engine tests do not wipe each other's fixtures.
  await Config.edit("global", (text) => {
    const current = (parseJsonc(text) as { agentConnections?: { products?: Record<string, unknown> } } | undefined)
      ?.agentConnections?.products
    return ConfigEdit.set(text, ["agentConnections", "products"], {
      claude: { enabled: false },
      codex: { enabled: false },
      opencode: { enabled: false },
      ...current,
      ...products,
    })
  })
}
