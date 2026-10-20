import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { I18n } from "../i18n"
import open from "open"
import type { Config, McpLocalConfig, McpRemoteConfig } from "@merakcode/sdk/client"
import { withEngine } from "../engine"

type McpEntry = NonNullable<Config["mcp"]>[string]

type McpConfigured = McpLocalConfig | McpRemoteConfig
function isMcpConfigured(config: McpEntry): config is McpConfigured {
  return typeof config === "object" && config !== null && "type" in config
}

export const McpCommand = cmd({
  command: "mcp",
  describe: I18n.t("cli.mcp.describe"),
  builder: (yargs) => yargs.command(McpListCommand).command(McpAuthCommand).demandCommand(),
  async handler() {},
})

/** Engine error bodies are `{ name, data }`; match on `name`. */
function authError(name: string, error: unknown) {
  const kind = typeof error === "object" && error !== null && "name" in error ? error.name : undefined
  if (kind === "McpServerNotFoundError") return I18n.t("cli.mcp.auth.notFound", { name })
  if (kind === "McpUnsupportedOAuthError") return I18n.t("cli.mcp.auth.unsupported", { name })
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "data" in error
        ? JSON.stringify(error.data)
        : String(error)
  return I18n.t("cli.mcp.auth.failed", { error: message })
}

/**
 * OAuth for a remote MCP server: opens a local browser, waits for the callback to exchange the code for a token, then
 * reconnects to confirm it works. The token is stored in the local data directory; running sessions can use it after
 * reconnecting to that server.
 */
export const McpAuthCommand = cmd({
  command: "auth <name>",
  describe: I18n.t("cli.mcp.auth.describe"),
  builder: (yargs) =>
    yargs.positional("name", { type: "string", describe: I18n.t("cli.mcp.auth.name"), demandOption: true }),
  async handler(args) {
    const name = args.name
    await withEngine(async (sdk) => {
      UI.empty()
      prompts.intro(I18n.t("cli.mcp.auth.title", { name }))

      const started = await sdk.mcp.auth
        .start({ name }, { throwOnError: true })
        .then((x) => x.data)
        .catch((error: unknown) => {
          prompts.log.error(authError(name, error))
        })
      if (!started) {
        process.exitCode = 1
        return
      }

      // The browser may fail to open (e.g. no desktop), so print the URL first for the user to open manually.
      prompts.log.info(I18n.t("cli.mcp.auth.open", { url: started.authorizationUrl }))
      void open(started.authorizationUrl).catch(() => {})
      const spinner = prompts.spinner()
      spinner.start(I18n.t("cli.mcp.auth.waiting"))
      // After the callback and token exchange the engine reconnects; if that fails the token is still saved, the server
      // is just not reachable yet.
      const failure = await sdk.mcp.auth
        .wait({ name, state: started.oauthState }, { throwOnError: true })
        .then((x) => x.data)
        .then((status) =>
          status.status === "connected"
            ? undefined
            : I18n.t("cli.mcp.auth.notConnected", {
                status: "error" in status ? `${status.status}: ${status.error}` : status.status,
              }),
        )
        .catch((error: unknown) => authError(name, error))
      if (failure) {
        spinner.error(failure)
        process.exitCode = 1
        return
      }
      spinner.stop(I18n.t("cli.mcp.auth.success", { name }))
      prompts.outro(I18n.t("cli.mcp.auth.done"))
    })
  },
})

export const McpListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: I18n.t("cli.mcp.list"),
  async handler() {
    await withEngine(async (sdk) => {
      UI.empty()
      prompts.intro(I18n.t("cli.mcp.intro"))

      const [config, statuses] = await Promise.all([
        sdk.config.get(undefined, { throwOnError: true }).then((x) => x.data),
        sdk.mcp.status(undefined, { throwOnError: true }).then((x) => x.data),
      ])
      const mcpServers = config.mcp ?? {}

      const servers = Object.entries(mcpServers).filter((entry): entry is [string, McpConfigured] =>
        isMcpConfigured(entry[1]),
      )

      if (servers.length === 0) {
        prompts.log.warn(I18n.t("cli.mcp.none"))
        prompts.outro(I18n.t("cli.mcp.addHint"))
        return
      }

      for (const [name, serverConfig] of servers) {
        const status = statuses[name]

        let statusIcon: string
        let statusText: string
        let hint = ""

        if (!status) {
          statusIcon = "○"
          statusText = "not initialized"
        } else if (status.status === "connected") {
          statusIcon = "✓"
          statusText = "connected"
        } else if (status.status === "disabled") {
          statusIcon = "○"
          statusText = "disabled"
        } else if (status.status === "needs_auth") {
          // Waiting for OAuth is not a failure; just tell the user to authorize.
          statusIcon = "!"
          statusText = "needs auth"
          hint = "\n    " + I18n.t("cli.mcp.authHint", { name })
        } else {
          statusIcon = "✗"
          statusText = "failed"
          hint = "\n    " + status.error
        }

        const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
        prompts.log.info(
          `${statusIcon} ${name} ${UI.Style.TEXT_DIM}${statusText}${hint}\n    ${UI.Style.TEXT_DIM}${typeHint}`,
        )
      }

      prompts.outro(`${servers.length} server(s)`)
    })
  },
})
