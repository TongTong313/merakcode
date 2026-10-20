import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { I18n } from "../i18n"
import { withEngine } from "../engine"
import type { MerakCodeClient } from "@merakcode/sdk/client"
import os from "os"
import { setTimeout as delay } from "node:timers/promises"
import { Process } from "@merakcode/util/process"

/**
 * Plugin-provided OAuth login: answers the plugin's prompts one by one (conditions and validation run in the engine;
 * invalid answers are asked again with the reason), then waits for the callback or lets the user paste the code.
 */
async function oauth(sdk: MerakCodeClient, providerID: string, method: number) {
  await delay(10)
  const inputs: Record<string, string> = {}
  for (;;) {
    const next = await sdk.provider.oauth
      .prompt({ providerID, method, inputs }, { throwOnError: true })
      .then((x) => x.data)
    if (!next.prompt) break
    if (next.error) prompts.log.error(next.error)
    const item = next.prompt
    const value =
      item.type === "select"
        ? await prompts.select({ message: item.message, options: item.options })
        : await prompts.text({ message: item.message, placeholder: item.placeholder })
    if (prompts.isCancel(value)) throw new UI.CancelledError()
    inputs[item.key] = value
  }

  const authorize = await sdk.provider.oauth
    .authorize({ providerID, method, inputs }, { throwOnError: true })
    .then((x) => x.data)
  if (authorize?.url) prompts.log.info(I18n.t("cli.provider.goTo", { url: authorize.url }))

  if (authorize?.method === "auto") {
    if (authorize.instructions) prompts.log.info(authorize.instructions)
    const spinner = prompts.spinner()
    spinner.start(I18n.t("cli.provider.waiting"))
    const result = await sdk.provider.oauth.callback({ providerID, method })
    if (result.error) spinner.error(I18n.t("cli.provider.failed"))
    else spinner.stop(I18n.t("cli.provider.success"))
  }

  if (authorize?.method === "code") {
    const code = await prompts.text({
      message: I18n.t("cli.provider.pasteCode"),
      validate: (x) => (x && x.length > 0 ? undefined : "Required"),
    })
    if (prompts.isCancel(code)) throw new UI.CancelledError()
    const result = await sdk.provider.oauth.callback({ providerID, method, code })
    if (result.error) prompts.log.error(I18n.t("cli.provider.failed"))
    else prompts.log.success(I18n.t("cli.provider.success"))
  }

  prompts.outro(I18n.t("cli.done"))
}

export const ProviderCommand = cmd({
  command: "provider",
  describe: I18n.t("cli.provider.describe"),
  builder: (yargs) =>
    yargs.command(ProviderListCommand).command(ProviderLoginCommand).command(ProviderLogoutCommand).demandCommand(),
  async handler() {},
})

export const ProviderListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: I18n.t("cli.provider.list"),
  async handler() {
    const [stored, providers] = await withEngine((sdk) =>
      Promise.all([
        sdk.auth.list({ throwOnError: true }).then((x) => x.data),
        sdk.provider.list(undefined, { throwOnError: true }).then((x) => x.data.all),
      ]),
    )
    const names = new Map(providers.map((provider) => [provider.id, provider.name]))

    UI.empty()
    const homedir = os.homedir()
    const displayPath = stored.file.startsWith(homedir) ? stored.file.replace(homedir, "~") : stored.file
    prompts.intro(`${I18n.t("cli.provider.credentials")} ${UI.Style.TEXT_DIM}${displayPath}`)
    for (const { providerID, type } of stored.credentials) {
      prompts.log.info(`${names.get(providerID) || providerID} ${UI.Style.TEXT_DIM}${type}`)
    }
    prompts.outro(I18n.t("cli.provider.credentialCount", { count: stored.credentials.length }))

    const activeEnvVars = providers.flatMap((provider) =>
      provider.env.filter((envVar) => process.env[envVar]).map((envVar) => ({ provider: provider.name, envVar })),
    )
    if (activeEnvVars.length > 0) {
      UI.empty()
      prompts.intro(I18n.t("cli.provider.environment"))

      for (const { provider, envVar } of activeEnvVars) {
        prompts.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      prompts.outro(I18n.t("cli.provider.envVars", { count: activeEnvVars.length }))
    }
  },
})

export const ProviderLoginCommand = cmd({
  command: "login [url]",
  describe: I18n.t("cli.provider.login"),
  builder: (yargs) =>
    yargs.positional("url", {
      describe: I18n.t("cli.provider.url"),
      type: "string",
    }),
  async handler(args) {
    await withEngine(async (sdk) => {
      UI.empty()
      prompts.intro(I18n.t("cli.provider.add"))
      // `provider login <url>` runs the login command published at the server's well-known endpoint.
      if (args.url) {
        const wellknown = (await fetch(`${args.url}/.well-known/merakcode`).then((x) => x.json())) as {
          auth: { command: string[]; env: string }
        }
        prompts.log.info(I18n.t("cli.provider.running", { command: wellknown.auth.command.join(" ") }))
        const proc = Process.spawn(wellknown.auth.command, {
          stdout: "pipe",
        })
        const exit = await proc.exited
        if (exit !== 0) {
          prompts.log.error(I18n.t("cli.failed"))
          prompts.outro(I18n.t("cli.done"))
          return
        }
        const token = await new Response(proc.stdout).text()
        await sdk.auth.set(
          { providerID: args.url, auth: { type: "wellknown", key: wellknown.auth.env, token: token.trim() } },
          { throwOnError: true },
        )
        prompts.log.success(I18n.t("cli.provider.loggedInto", { url: args.url }))
        prompts.outro(I18n.t("cli.done"))
        return
      }

      await sdk.provider.catalog.refresh()
      const [providers, methods] = await Promise.all([
        sdk.provider.list(undefined, { throwOnError: true }).then((x) => x.data.all),
        sdk.provider.auth(undefined, { throwOnError: true }).then((x) => x.data),
      ])

      if (providers.length === 0) {
        prompts.log.warn(I18n.t("cli.provider.noneAvailable"))
        prompts.outro(I18n.t("cli.done"))
        return
      }

      const provider = await prompts.autocomplete({
        message: I18n.t("cli.provider.select"),
        maxItems: 8,
        options: providers
          .toSorted((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
          .map((x) => ({ label: x.name, value: x.id })),
      })
      if (prompts.isCancel(provider)) throw new UI.CancelledError()

      // Login methods provided by plugins for this provider: pick one if there are several. OAuth runs the plugin flow;
      // API keys use the prompt below.
      const available = methods[provider] ?? []
      const index = await (async () => {
        if (available.length <= 1) return 0
        const method = await prompts.select({
          message: I18n.t("cli.provider.method"),
          options: available.map((x, index) => ({ label: x.label, value: index.toString() })),
        })
        if (prompts.isCancel(method)) throw new UI.CancelledError()
        return parseInt(method)
      })()
      if (available[index]?.type === "oauth") return oauth(sdk, provider, index)

      const key = await prompts.password({
        message: I18n.t("cli.provider.apiKey"),
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(key)) throw new UI.CancelledError()
      await sdk.auth.set({ providerID: provider, auth: { type: "api", key } }, { throwOnError: true })

      prompts.outro(I18n.t("cli.done"))
    })
  },
})

export const ProviderLogoutCommand = cmd({
  command: "logout",
  describe: I18n.t("cli.provider.logout"),
  async handler() {
    await withEngine(async (sdk) => {
      const [stored, config, providers] = await Promise.all([
        sdk.auth.list({ throwOnError: true }).then((x) => x.data.credentials),
        sdk.config.get(undefined, { throwOnError: true }).then((x) => x.data),
        sdk.provider.list(undefined, { throwOnError: true }).then((x) => x.data.all),
      ])
      UI.empty()
      prompts.intro(I18n.t("cli.provider.remove"))
      if (stored.length === 0) {
        prompts.log.error(I18n.t("cli.provider.noCredentials"))
        return
      }
      // Providers defined in the user's config cannot be disconnected, matching the web UI and TUI.
      const configured = new Set(Object.keys(config.provider ?? {}))
      const removable = stored.filter((item) => !configured.has(item.providerID))
      if (removable.length === 0) {
        prompts.log.error(I18n.t("cli.provider.noRemovable"))
        return
      }
      const names = new Map(providers.map((provider) => [provider.id, provider.name]))
      const providerID = await prompts.select({
        message: I18n.t("cli.provider.select"),
        options: removable.map((item) => ({
          label: (names.get(item.providerID) || item.providerID) + UI.Style.TEXT_DIM + " (" + item.type + ")",
          value: item.providerID,
        })),
      })
      if (prompts.isCancel(providerID)) throw new UI.CancelledError()
      await sdk.auth.remove({ providerID }, { throwOnError: true })
      prompts.outro(I18n.t("cli.provider.loggedOut"))
    })
  },
})
