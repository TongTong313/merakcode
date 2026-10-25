import z from "zod"
import { Network } from "@merakcode/util/network"
import { Project } from "@merakcode/util/project"
import { createHash } from "crypto"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type LanguageModel } from "ai"
import { Log } from "@merakcode/log/logger"
import { Npm } from "../npm"
import { Plugin } from "../plugin"
import { OFFICIAL, OFFICIAL_PROVIDER_IDS, official, type OfficialID } from "./official"
import * as Catalog from "./catalog"
import { NamedError } from "@merakcode/util/error"
import { Auth } from "../auth"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { Storage } from "../storage/storage"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"

// Direct imports for bundled providers
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { ProviderTransform } from "./transform"
import { Relay } from "./relay"
import { Text } from "../util/text"
import { Agent } from "undici"
import { parseModel as parseModelRef, sortModels } from "@merakcode/util/model"
import { applyHomepage } from "./homepage"

export namespace Provider {
  const log = Log.create({ service: "provider" })

  /** A model-list fetch failed. The code follows the HTTP status: 401 and 403 are MRK-2001, 429 is MRK-2004. */
  export const CatalogRefreshError = NamedError.create(
    "CatalogRefreshError",
    z.object({
      providerID: z.string(),
      message: z.string(),
      statusCode: z.number().optional(),
    }),
  )

  /**
   * Connection pool for model requests, without fetch's default timeouts (5 minutes each for headers and the next
   * chunk). Reasoning models can take a long time before the first token, and long outputs pause mid-stream; timeouts
   * come from the provider's timeout option instead (see options.fetch below).
   */
  let pool: Agent | undefined
  const unbounded = () => (pool ??= new Agent({ headersTimeout: 0, bodyTimeout: 0 }))

  export const Event = {
    Changed: BusEvent.define(
      "provider.changed",
      z.object({
        providerID: z.string().optional(),
        reason: z.enum(["connected", "disconnected", "refreshed", "refresh-failed"]),
        error: CatalogRefreshError.Schema.optional(),
      }),
    ),
  }

  export function publishChanged(properties: z.output<(typeof Event.Changed)["properties"]>) {
    return Bus.publishGlobal(Event.Changed, properties)
  }

  /** Instance created by a bundled provider package */
  type SDK = { languageModel(modelId: string): Exclude<LanguageModel, string> }

  const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
    "@ai-sdk/anthropic": createAnthropic,
    "@ai-sdk/google": createGoogleGenerativeAI,
    "@ai-sdk/openai": createOpenAI,
    "@ai-sdk/openai-compatible": createOpenAICompatible,
    "@openrouter/ai-sdk-provider": createOpenRouter,
  }

  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
  type CustomLoader = (provider: Info) => Promise<{
    autoload: boolean
    getModel?: CustomModelLoader
    options?: Record<string, any>
  }>

  const CUSTOM_LOADERS: Record<string, CustomLoader> = {
    async anthropic() {
      return {
        autoload: false,
        options: {
          headers: {
            "anthropic-beta":
              "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }
    },
    openai: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: {},
      }
    },
    openrouter: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": Project.HOMEPAGE,
            "X-Title": Project.NAME,
          },
        },
      }
    },
  }

  /** Price per million tokens. */
  const Rate = z.object({
    input: z.number(),
    output: z.number(),
    cache: z.object({ read: z.number(), write: z.number() }),
  })

  export const Model = z
    .object({
      id: z.string(),
      providerID: z.string(),
      api: z.object({
        id: z.string(),
        url: z.string(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: Rate.extend({
        currency: z.enum(["USD", "CNY"]).optional(),
        tiers: z.array(Rate.extend({ above: z.number(), thinking: Rate.optional() })).optional(),
        thinking: Rate.optional(),
      }).optional(),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      homepage: z.boolean().optional(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
      defaultVariant: z.string().optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      origin: z.enum(["official", "configured"]).optional(),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  async function loadCatalog(): Promise<Record<string, Info>> {
    const pub = await Catalog.readPublic()
    const result: Record<string, Info> = {}
    for (const spec of Object.values(OFFICIAL)) {
      const models = await Catalog.read(spec.id)
      const built: Record<string, Model> = {}
      for (const model of models) {
        built[model.id] = Catalog.toProviderModel({
          providerID: spec.id,
          npm: spec.npm,
          url: spec.api,
          interleaved: spec.interleaved,
          official: model,
          public: Catalog.lookup(pub, spec.id, model.id),
          fallback: Catalog.fallbackFor(spec.id, model.id),
        })
      }
      result[spec.id] = {
        id: spec.id,
        source: "custom",
        origin: "official",
        name: spec.name,
        env: [...spec.env],
        options: {},
        models: built,
      }
    }
    return result
  }

  /** Plugins hand back finished models; they still get the shared level menu and default. */
  function withLevels(model: Model) {
    if (!model.variants || Object.keys(model.variants).length === 0) ProviderTransform.fillVariants(model, {})
    else model.defaultVariant ??= ProviderTransform.pickDefault(Object.keys(model.variants), undefined)
    return model
  }

  /** Sorts providers by name for the /provider and /config/providers lists */
  export function sortProvidersByPriority<T extends { id: string; name?: string }>(providers: readonly T[]): T[] {
    return sortBy(providers, [(p) => p.name ?? p.id, "asc"])
  }

  /** Order of connected providers; the default model comes from the first one. Official providers use their catalog order, then name. */
  export function rank<T extends Pick<Info, "id" | "name">>(providers: readonly T[]): T[] {
    const preferred = (p: T) => {
      const index = OFFICIAL_PROVIDER_IDS.findIndex((id) => id === p.id)
      return index === -1 ? OFFICIAL_PROVIDER_IDS.length : index
    }
    return sortBy(providers, [preferred, "asc"], [(p) => p.name, "asc"])
  }

  /**
   * Official providers from the local catalog, filtered by enabled/disabled.
   * Same source as `all` in GET `/` of `server/routes/provider` (without the `connected` merge).
   */
  export async function getFilteredProviders(): Promise<Record<string, Info>> {
    const config = await Config.get()
    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
    const allProviders = await loadCatalog()
    for (const [providerID, provider] of Object.entries(allProviders)) {
      applyHomepage(provider, config.provider?.[providerID]?.picker)
    }
    return Object.fromEntries(
      Object.entries(allProviders).filter(([key]) => (enabled ? enabled.has(key) : true) && !disabled.has(key)),
    )
  }

  /**
   * Pulls one connected official provider, or every connected one plus the public catalog. Reads the global config:
   * credentials and the catalog cache are global, and the save-key route and the hourly timer run outside a project.
   */
  export async function refreshCatalog(providerID?: string, force = false) {
    const config = await Config.getGlobal()
    const base = (id: string) => {
      const spec = official(id)
      const configured = config.provider?.[id]?.options?.baseURL
      return (typeof configured === "string" && configured) || spec?.api || ""
    }
    const failures: Array<ReturnType<InstanceType<typeof CatalogRefreshError>["toObject"]>> = []
    const written: string[] = []
    let attempted = false
    let wrote = false
    const note = async (id: string, result: Catalog.RefreshResult) => {
      if (result.ok) {
        wrote = true
        if (id !== "public") written.push(id)
        return
      }
      // The public catalog only fills in limits. A failure there stays in the log.
      if (id === "public") return
      const error = new CatalogRefreshError({
        providerID: id,
        message: result.message,
        statusCode: result.statusCode,
      }).toObject()
      failures.push(error)
      await publishChanged({ providerID: id, reason: "refresh-failed", error })
    }
    if ((!providerID || providerID === "public") && (force || (await Catalog.stale("public")))) {
      attempted = true
      await note("public", await Catalog.refreshPublic())
    }
    const ids = providerID && providerID !== "public" ? [providerID] : [...OFFICIAL_PROVIDER_IDS]
    const pub = Catalog.publicIDs(await Catalog.readPublic())
    for (const id of ids) {
      if (!force && !(await Catalog.stale(id))) continue
      const auth = await Auth.get(id)
      const configuredKey = config.provider?.[id]?.options?.apiKey
      const key = auth?.type === "api" && auth.key ? auth.key : typeof configuredKey === "string" ? configuredKey : ""
      if (!key) continue
      attempted = true
      await note(id, await Catalog.refresh(id, { key, baseURL: base(id), publicIDs: pub }))
    }
    if (wrote) {
      invalidateAll()
      // One event per provider that actually got a new list, so the UI can forget that provider's failure.
      const refreshed = written.length > 0 ? written : [providerID]
      for (const id of refreshed) await publishChanged({ providerID: id, reason: "refreshed" })
    }
    return { updated: attempted ? wrote : true, failures }
  }

  function extractHost(url: string): string {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  }

  /**
   * Reads the model actually used from an OpenAI-compatible request body; with a cached SDK, the model.id in the
   * closure may not belong to the current request
   */
  function tryExtractRequestModelId(body: unknown): string | undefined {
    if (typeof body !== "string" || !body) return undefined
    try {
      const json = JSON.parse(body) as { model?: unknown }
      if (typeof json.model === "string") return json.model
    } catch {
      /* not a JSON body */
    }
    return undefined
  }

  /**
   * Diagnostic text for connection failures. Both languages start with a fixed prefix ("Unable to connect to" and
   * its Chinese equivalent), which Message.fromError and the desktop app use to detect network errors.
   */
  function buildConnectionErrorMessage(providerID: string, modelId: string, url: string) {
    return Text.pick(
      {
        zh: "无法连接到模型 {model} 的 API 服务（{host}）。请检查网络连接是否正常、API 地址配置是否正确，也可能是该服务暂时不可用。",
        en: "Unable to connect to the API service of model {model} ({host}). Check the network connection and the API address configuration; the service may also be temporarily unavailable.",
      },
      { model: `${providerID}/${modelId}`, host: extractHost(url) },
    )
  }

  const cachedState = Instance.state(async () => {
    using _ = log.time("state")

    const configStarted = Date.now()
    log.info("provider.config.started")
    const config = await Config.get()
    log.info("provider.config.completed", {
      duration: Date.now() - configStarted,
      configuredProviders: Object.keys(config.provider ?? {}).length,
      configuredPlugins: config.plugin?.length ?? 0,
    })

    const modelsStarted = Date.now()
    log.info("provider.models.started")
    const database = await loadCatalog()
    log.info("provider.models.completed", {
      duration: Date.now() - modelsStarted,
      providers: Object.keys(database).length,
    })

    const mapStarted = Date.now()
    const pub = await Catalog.readPublic()
    log.info("provider.models.map.completed", {
      duration: Date.now() - mapStarted,
      providers: Object.keys(database).length,
    })

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null

    function isProviderAllowed(providerID: string): boolean {
      if (enabled && !enabled.has(providerID)) return false
      return !disabled.has(providerID)
    }

    const providers: { [providerID: string]: Info } = {}
    const languages = new Map<string, Exclude<LanguageModel, string>>()
    const modelLoaders: {
      [providerID: string]: CustomModelLoader
    } = {}
    const sdk = new Map<string, SDK>()
    // Providers a custom loader or plugin auth confirmed for autoload (e.g. Bedrock profile, OIDC); no apiKey needed
    const loaderAuthorized = new Set<string>()

    log.info("init")

    const configProviders = Object.entries(config.provider ?? {})

    function mergeProvider(providerID: string, provider: Partial<Info>) {
      const existing = providers[providerID]
      if (existing) {
        // @ts-expect-error
        providers[providerID] = mergeDeep(existing, provider)
        return
      }
      const match = database[providerID]
      if (!match) return
      // @ts-expect-error
      providers[providerID] = mergeDeep(match, provider)
    }

    // extend database from config
    for (const [providerID, provider] of configProviders) {
      const existing = database[providerID]
      const parsed: Info = {
        id: providerID,
        name: provider.name ?? existing?.name ?? providerID,
        env: provider.env ?? existing?.env ?? [],
        options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
        source: "config",
        origin: official(providerID) ? "official" : "configured",
        models: existing?.models ?? {},
      }

      const spec = official(providerID)
      const cached = new Map((await Catalog.read(providerID)).map((model) => [model.id, model]))
      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        const extra = Catalog.configExtras(modelID, model, { npm: provider.npm, api: provider.api })
        const existingModel = parsed.models[modelID]
        const alias = model.id && model.id !== modelID ? modelID : undefined
        const parsedModel = Catalog.toProviderModel({
          providerID,
          npm: extra.npm ?? existingModel?.api.npm ?? spec?.npm ?? "@ai-sdk/openai-compatible",
          url: extra.url ?? existingModel?.api.url ?? spec?.api ?? provider.api ?? "",
          interleaved: spec?.interleaved ?? false,
          official: cached.get(modelID),
          public: Catalog.lookup(pub, providerID, modelID),
          fallback: Catalog.fallbackFor(providerID, modelID),
          config: Catalog.fromConfig(modelID, { ...model, name: model.name ?? alias ?? existingModel?.name }),
          apiID: extra.apiID,
          headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
          options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
          family: model.family ?? existingModel?.family,
          configInterleaved: extra.interleaved,
        })
        const merged = mergeDeep(parsedModel.variants ?? {}, model.variants ?? {})
        parsedModel.variants = mapValues(
          pickBy(merged, (v) => !v.disabled),
          (v) => omit(v, ["disabled"]),
        )
        if (!parsedModel.variants[parsedModel.defaultVariant ?? ""]) {
          parsedModel.defaultVariant = ProviderTransform.pickDefault(Object.keys(parsedModel.variants), undefined)
        }
        parsed.models[modelID] = parsedModel
      }
      database[providerID] = parsed
    }
    const unfetched = new Set(
      OFFICIAL_PROVIDER_IDS.filter((id) => Object.keys(database[id]?.models ?? {}).length === 0),
    )

    // load apikeys the user saved. Environment variables are not credentials.
    for (const [providerID, provider] of Object.entries(await Auth.all())) {
      if (disabled.has(providerID)) continue
      if (provider.type === "api") {
        log.info("load apikeys: merging", { providerID })
        mergeProvider(providerID, {
          source: "api",
          key: provider.key,
        })
      }
    }

    for (const plugin of await Plugin.list()) {
      if (!plugin.auth) continue
      const providerID = plugin.auth.provider
      if (disabled.has(providerID)) continue

      if (!plugin.auth.loader) continue
      if (!(await Auth.get(providerID))) continue
      const options = await plugin.auth.loader(() => Auth.get(providerID) as any, database[plugin.auth.provider])
      const opts = options ?? {}
      const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
      mergeProvider(providerID, patch)
      loaderAuthorized.add(providerID)
    }

    for (const [providerID, fn] of Object.entries(CUSTOM_LOADERS)) {
      if (disabled.has(providerID)) continue
      const data = database[providerID]
      if (!data) {
        log.error("Provider does not exist in model list " + providerID)
        continue
      }
      const result = await fn(data)
      if (result && (result.autoload || providers[providerID])) {
        if (result.getModel) modelLoaders[providerID] = result.getModel
        const opts = result.options ?? {}
        const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
        mergeProvider(providerID, patch)
        // Only autoload: true means the loader confirmed credentials (profile, IAM, etc.);
        // prefilled config without credentials is not enough
        if (result.autoload) loaderAuthorized.add(providerID)
      }
    }

    // load config
    for (const [providerID, provider] of configProviders) {
      const partial: Partial<Info> = { source: "config" }
      if (provider.env) partial.env = provider.env
      if (provider.name) partial.name = provider.name
      if (provider.options) partial.options = provider.options
      mergeProvider(providerID, partial)
    }

    for (const [providerID, provider] of Object.entries(providers)) {
      if (!isProviderAllowed(providerID)) {
        delete providers[providerID]
        continue
      }

      // Without a key the user entered, the provider is not listed. Plugin loaders that already confirmed
      // credentials pass via loaderAuthorized.
      const optionKey = provider.options?.apiKey
      const hasApiKey = !!(provider.key || (typeof optionKey === "string" && optionKey.length > 0))
      const hasAuthFetch = typeof provider.options?.fetch === "function"
      if (!hasApiKey && !hasAuthFetch && !loaderAuthorized.has(providerID)) {
        delete providers[providerID]
        continue
      }

      const configProvider = config.provider?.[providerID]

      for (const [modelID, model] of Object.entries(provider.models)) {
        model.api.id = model.api.id ?? model.id ?? modelID
        if (modelID === "gpt-5-chat-latest" || (providerID === "openrouter" && modelID === "openai/gpt-5-chat"))
          delete provider.models[modelID]
        if (model.status === "alpha" && !Flag.MERAKCODE_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
        if (model.status === "deprecated") delete provider.models[modelID]
        if (
          (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
          (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
        )
          delete provider.models[modelID]
      }

      // A connected official provider stays listed before its first successful fetch.
      if (Object.keys(provider.models).length === 0 && !unfetched.has(providerID as OfficialID)) {
        delete providers[providerID]
        continue
      }

      log.info("found", { providerID })
    }

    // Whole provider catalogs registered by plugins are merged after the official providers are admitted and
    // filtered; plugins own access control for their catalogs, but the user's disabled_providers still applies.
    const custom = await Plugin.customProviders()
    for (const [providerID, provider] of Object.entries(custom)) {
      if (disabled.has(providerID)) continue
      for (const model of Object.values(provider.models)) withLevels(model)
      providers[providerID] = { ...provider, origin: official(providerID) ? "official" : "configured" }
    }

    // `provider.models()` hook: only plugins whose `hook.id` matches the provider are called; they replace its models
    // and ids/providerID are normalized. It runs last because plugin-registered providers exist only after the merge;
    // the cost is that the user's allow/deny lists do not trim plugin models. Skipped when no plugin implements it,
    // since each provider needs an Auth read.
    if (await Plugin.hasProviderModels()) {
      for (const [providerID, provider] of Object.entries(providers)) {
        const next = await Plugin.customModels(provider, { auth: (await Auth.get(providerID)) ?? undefined })
        // undefined: no plugin owns this provider, keep the models found so far
        if (!next) continue
        provider.models = Object.fromEntries(
          Object.entries(next).map(([modelID, model]) => [modelID, withLevels({ ...model, id: modelID, providerID })]),
        )
        // Empty: the plugin says the provider has no usable models right now (e.g. not logged in). Same rule as above,
        // a provider without models is not listed, so clients never get an empty provider
        if (Object.keys(provider.models).length === 0) {
          delete providers[providerID]
          log.info("plugin models emptied provider", { providerID })
          continue
        }
        log.info("plugin models applied", { providerID, models: Object.keys(provider.models).length })
      }
    }

    for (const [providerID, provider] of Object.entries(providers)) {
      applyHomepage(provider, config.provider?.[providerID]?.picker)
    }

    return {
      models: languages,
      providers,
      sdk,
      modelLoaders,
    }
  })

  function state() {
    return cachedState()
  }

  export async function list() {
    return state().then((state) => state.providers)
  }

  export function invalidate() {
    cachedState.invalidate()
  }

  export function invalidateAll() {
    cachedState.invalidateAll()
  }

  async function getSDK(model: Model) {
    try {
      using _ = log.time("getSDK", {
        providerID: model.providerID,
      })
      const s = await state()
      const provider = s.providers[model.providerID]
      // Do not read provider.options on a missing provider (the error would not say which provider); reuse getModel's
      // check to throw a descriptive error
      if (!provider) {
        await getModel(model.providerID, model.id) // always throws for a missing provider
        throw new ModelNotFoundError({ providerID: model.providerID, modelID: model.id }) // unreachable, defensive
      }
      const options = { ...provider.options }

      if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
        options["includeUsage"] = true
      }

      if (!options["baseURL"]) options["baseURL"] = model.api.url
      if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
      if (model.headers)
        options["headers"] = {
          ...options["headers"],
          ...model.headers,
        }
      const relay = (await Config.get()).provider?.[model.providerID]?.relay
      const anthropic = model.api.npm.includes("@ai-sdk/anthropic")
      const bearer = relay?.kind === "claude-code" || (relay?.kind === "custom" && relay.auth === "bearer")
      if (anthropic && bearer) {
        const key = options["apiKey"] ?? provider.key
        if (typeof key === "string") {
          options["authToken"] = key
          delete options["apiKey"]
        }
      }
      if (relay?.kind === "claude-code") {
        options["headers"] = {
          ...options["headers"],
          "anthropic-beta": Relay.CLAUDE_CODE_BETA,
        }
      }

      const key = createHash("sha1")
        .update(JSON.stringify({ providerID: model.providerID, npm: model.api.npm, options }))
        .digest("hex")
      const existing = s.sdk.get(key)
      if (existing) return existing

      const customFetch = options["fetch"]
      // The plugin provider.fetch hook wraps the layer that sends the request, outside the user's custom fetch (proxy,
      // etc.); without a hook the base fetch is returned unchanged.
      const wrappedFetch = await Plugin.wrapProviderFetch(
        { providerID: model.providerID, modelID: model.id },
        customFetch ?? fetch,
      )

      options["fetch"] = async (input: any, init?: RequestInit) => {
        const fetchFn = wrappedFetch
        let opts = init ?? {}

        // The AI SDK and the chat path replace User-Agent after the provider is built. Put the Claude Code
        // identity on the request that is about to leave, so a relay can still see claude-cli first.
        if (relay?.kind === "claude-code") {
          const headers = new Headers(opts.headers)
          const current = headers.get("user-agent") ?? ""
          if (!current.startsWith("claude-cli/")) {
            headers.set("user-agent", [Relay.CLAUDE_CODE_USER_AGENT, current].filter(Boolean).join(" "))
          }
          opts = { ...opts, headers }
        }

        if (options["timeout"] !== undefined && options["timeout"] !== null) {
          const signals: AbortSignal[] = []
          if (opts.signal) signals.push(opts.signal)
          if (options["timeout"] !== false) signals.push(AbortSignal.timeout(options["timeout"]))

          const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

          opts.signal = combined
        }

        // Strip openai itemId metadata following what codex does
        // Codex uses #[serde(skip_serializing)] on id fields for all item types:
        // Message, Reasoning, FunctionCall, LocalShellCall, CustomToolCall, WebSearchCall
        if (model.api.npm === "@ai-sdk/openai" && opts.body && opts.method === "POST") {
          const body = JSON.parse(opts.body as string)
          if (Array.isArray(body.input)) {
            for (const item of body.input) {
              if ("id" in item) delete item.id
            }
            opts.body = JSON.stringify(body)
          }
        }

        try {
          return await fetchFn(input, { ...opts, dispatcher: unbounded() } as RequestInit)
        } catch (e) {
          if (e instanceof Error && Network.failure(e) === "unreachable") {
            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input instanceof Request
                    ? input.url
                    : (options["baseURL"] ?? "unknown")
            const requestModelId = tryExtractRequestModelId(opts.body) ?? model.id
            throw new Error(await buildConnectionErrorMessage(model.providerID, requestModelId, url), { cause: e })
          }
          throw e
        }
      }

      const bundledFn = BUNDLED_PROVIDERS[model.api.npm]
      if (bundledFn) {
        log.info("using bundled provider", { providerID: model.providerID, pkg: model.api.npm })
        const loaded = bundledFn({
          name: model.providerID,
          ...options,
        })
        s.sdk.set(key, loaded)
        return loaded as SDK
      }

      let installedPath: string
      if (!model.api.npm.startsWith("file://")) {
        installedPath = await Npm.cached(model.api.npm, "latest")
      } else {
        log.info("loading local provider", { pkg: model.api.npm })
        installedPath = model.api.npm
      }

      const mod = await import(await Npm.entry(installedPath))

      const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
      const loaded = fn({
        name: model.providerID,
        ...options,
      })
      s.sdk.set(key, loaded)
      return loaded as SDK
    } catch (e) {
      // Pass getModel's descriptive error through instead of wrapping it in InitError, so both report the same error
      if (ModelNotFoundError.isInstance(e)) throw e
      throw new InitError({ providerID: model.providerID }, { cause: e })
    }
  }

  export async function getProvider(providerID: string) {
    return state().then((s) => s.providers[providerID])
  }

  export async function getModel(providerID: string, modelID: string) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) {
      const availableProviders = Object.keys(s.providers)
      const matches = fuzzysort.go(providerID, availableProviders, { limit: 3, threshold: 0 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }

    const info = provider.models[modelID]
    if (!info) {
      const availableModels = Object.keys(provider.models)
      const matches = fuzzysort.go(modelID, availableModels, { limit: 3, threshold: 0 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }
    return info
  }

  export async function getLanguage(model: Model): Promise<Exclude<LanguageModel, string>> {
    const s = await state()
    const key = `${model.providerID}/${model.id}`
    if (s.models.has(key)) return s.models.get(key)!

    const provider = s.providers[model.providerID]
    const sdk = await getSDK(model)

    try {
      const language = s.modelLoaders[model.providerID]
        ? await s.modelLoaders[model.providerID](sdk, model.api.id, provider.options)
        : sdk.languageModel(model.api.id)
      s.models.set(key, language)
      return language
    } catch (e) {
      if (e instanceof NoSuchModelError)
        throw new ModelNotFoundError(
          {
            modelID: model.id,
            providerID: model.providerID,
          },
          { cause: e },
        )
      throw e
    }
  }

  export async function closest(providerID: string, query: string[]) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) return undefined
    for (const item of query) {
      for (const modelID of Object.keys(provider.models)) {
        if (modelID.includes(item))
          return {
            providerID,
            modelID,
          }
      }
    }
  }

  export async function getSmallModel(providerID: string) {
    const cfg = await Config.get()

    if (cfg.small_model) {
      const parsed = parseModel(cfg.small_model)
      return getModel(parsed.providerID, parsed.modelID)
    }

    const provider = await state().then((state) => state.providers[providerID])
    if (provider) {
      let priority = [
        "claude-haiku-4-5",
        "claude-haiku-4.5",
        "3-5-haiku",
        "3.5-haiku",
        "gemini-3-flash",
        "gemini-2.5-flash",
        "gpt-5-nano",
      ]
      if (providerID.startsWith("alibaba")) {
        // qwen-flash succeeds qwen-turbo, which is no longer updated
        priority = ["qwen-flash", "qwen-turbo", "qwen-plus"]
      }

      for (const item of priority) {
        for (const model of Object.keys(provider.models)) {
          if (model.includes(item)) return getModel(providerID, model)
        }
      }
    }
    return undefined
  }

  type Ref = { providerID: string; modelID: string }
  const RECENT = ["model", "recent"]

  function recent() {
    return Storage.read<Ref[]>(RECENT).catch(() => [] as Ref[])
  }

  /** Records a model the user picked for a prompt; defaultModel falls back to the recent ones, newest first */
  export async function remember(model: Ref) {
    const others = (await recent()).filter(
      (item) => item.providerID !== model.providerID || item.modelID !== model.modelID,
    )
    await Storage.write(RECENT, [model, ...others].slice(0, 10))
  }

  export async function defaultModel() {
    const cfg = await Config.get()
    const providers = await list()
    // When cfg.model is not in the catalog: skip it if other providers are connected; with an empty catalog return it
    // anyway and let getModel report the error
    if (cfg.model) {
      const parsed = parseModel(cfg.model)
      if (providers[parsed.providerID]?.models[parsed.modelID]) return parsed
      if (Object.keys(providers).length === 0) return parsed
    }
    for (const entry of await recent()) {
      const provider = providers[entry.providerID]
      if (!provider) continue
      if (!provider.models[entry.modelID]) continue
      return { providerID: entry.providerID, modelID: entry.modelID }
    }

    const provider = rank(Object.values(providers)).find(
      (p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id),
    )
    if (!provider) throw new NoModelError({})
    const [model] = sortModels(Object.values(provider.models))
    if (!model) throw new NoModelError({ providerID: provider.id })
    return {
      providerID: provider.id,
      modelID: model.id,
    }
  }

  export const parseModel = parseModelRef

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: z.string(),
      modelID: z.string(),
      suggestions: z.array(z.string()).optional(),
    }),
  )

  /** No connected provider has a usable model, so there is no default model */
  export const NoModelError = NamedError.create("ProviderNoModelError", z.object({ providerID: z.string().optional() }))

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: z.string(),
    }),
  )
}

if (!Flag.MERAKCODE_DISABLE_CATALOG_FETCH) {
  const run = () => void Provider.refreshCatalog().catch(() => undefined)
  setTimeout(run, 1_000).unref()
  setInterval(run, 60 * 60 * 1000).unref()
}
