import z from "zod"
import { Network } from "@merakcode/util/network"
import { Project } from "@merakcode/util/project"
import os from "os"
import { createHash } from "crypto"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type LanguageModel } from "ai"
import { Log } from "@merakcode/log/logger"
import { Npm } from "../npm"
import { Plugin } from "../plugin"
import { ModelsDev, ReasoningOption } from "./models"
import { NamedError } from "@merakcode/util/error"
import { Auth } from "../auth"
import { Env } from "../env"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { iife } from "../util/iife"
import { Global } from "../global"
import path from "path"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"

// Direct imports for bundled providers
import { createAmazonBedrock, type AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createGateway } from "@ai-sdk/gateway"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createGitLab, VERSION as GITLAB_PROVIDER_VERSION } from "gitlab-ai-provider"
import { ProviderTransform } from "./transform"
import { Installation } from "../installation"
import { Filesystem } from "@merakcode/util/filesystem"
import { Text } from "../util/text"
import { Agent } from "undici"
import { parseModel as parseModelRef, sortModels } from "@merakcode/util/model"

export namespace Provider {
  const log = Log.create({ service: "provider" })

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
        reason: z.enum(["connected", "disconnected", "refreshed"]),
      }),
    ),
  }

  export function publishChanged(properties: z.output<(typeof Event.Changed)["properties"]>) {
    return Bus.publishGlobal(Event.Changed, properties)
  }

  /** Instance created by a provider package; spec versions differ (GitLab is still on v2), all work with streamText */
  type SDK = { languageModel(modelId: string): Exclude<LanguageModel, string> }

  const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
    "@ai-sdk/amazon-bedrock": createAmazonBedrock,
    "@ai-sdk/anthropic": createAnthropic,
    "@ai-sdk/azure": createAzure,
    "@ai-sdk/google": createGoogleGenerativeAI,
    "@ai-sdk/google-vertex": createVertex,
    "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
    "@ai-sdk/openai": createOpenAI,
    "@ai-sdk/openai-compatible": createOpenAICompatible,
    "@openrouter/ai-sdk-provider": createOpenRouter,
    "@ai-sdk/xai": createXai,
    "@ai-sdk/mistral": createMistral,
    "@ai-sdk/groq": createGroq,
    "@ai-sdk/deepinfra": createDeepInfra,
    "@ai-sdk/cerebras": createCerebras,
    "@ai-sdk/cohere": createCohere,
    "@ai-sdk/gateway": createGateway,
    "@ai-sdk/togetherai": createTogetherAI,
    "@ai-sdk/perplexity": createPerplexity,
    "gitlab-ai-provider": createGitLab,
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
    "alibaba-cn": async (input) => {
      const config = await Config.get()
      const opts = config.provider?.["alibaba-cn"]?.options ?? {}

      // API key lookup order: environment variable, then Auth, then the config file
      const apiKey = await (async () => {
        const envKey = Env.get("DASHSCOPE_API_KEY")
        if (envKey) return envKey
        const auth = await Auth.get(input.id)
        if (auth?.type === "api") {
          try {
            const p = JSON.parse(auth.key)
            if (p.apiKey) return p.apiKey
          } catch {}
        }
        return opts.apiKey
      })()
      if (!apiKey) return { autoload: false }

      const baseURL = opts.baseURL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"

      return { autoload: true, options: { apiKey, baseURL } }
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
    azure: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {},
      }
    },
    "azure-cognitive-services": async () => {
      const resourceName = Env.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {
          baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
        },
      }
    },
    "amazon-bedrock": async () => {
      const config = await Config.get()
      const providerConfig = config.provider?.["amazon-bedrock"]

      const auth = await Auth.get("amazon-bedrock")

      // Region precedence: 1) config file, 2) env var, 3) default
      const configRegion = providerConfig?.options?.region
      const envRegion = Env.get("AWS_REGION")
      const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

      // Profile: config file takes precedence over env var
      const configProfile = providerConfig?.options?.profile
      const envProfile = Env.get("AWS_PROFILE")
      const profile = configProfile ?? envProfile

      const awsAccessKeyId = Env.get("AWS_ACCESS_KEY_ID")

      // TODO: Using process.env directly because Env.set only updates a process.env shallow copy,
      // until the scope of the Env API is clarified (test only or runtime?)
      const awsBearerToken = iife(() => {
        const envToken = process.env.AWS_BEARER_TOKEN_BEDROCK
        if (envToken) return envToken
        if (auth?.type === "api") {
          process.env.AWS_BEARER_TOKEN_BEDROCK = auth.key
          return auth.key
        }
        return undefined
      })

      const awsWebIdentityTokenFile = Env.get("AWS_WEB_IDENTITY_TOKEN_FILE")

      const containerCreds = Boolean(
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
      )

      if (!profile && !awsAccessKeyId && !awsBearerToken && !awsWebIdentityTokenFile && !containerCreds)
        return { autoload: false }

      const providerOptions: AmazonBedrockProviderSettings = {
        region: defaultRegion,
      }

      // Only use credential chain if no bearer token exists
      // Bearer token takes precedence over credential chain (profiles, access keys, IAM roles, web identity tokens)
      if (!awsBearerToken) {
        const { fromNodeProviderChain } = await import(
          await Npm.entry(await Npm.cached("@aws-sdk/credential-providers"))
        )

        // Build credential provider options (only pass profile if specified)
        const credentialProviderOptions = profile ? { profile } : {}

        providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
      }

      // Add custom endpoint if specified (endpoint takes precedence over baseURL)
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) {
        providerOptions.baseURL = endpoint
      }

      return {
        autoload: true,
        options: providerOptions,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          // Skip region prefixing if model already has a cross-region inference profile prefix
          // Models from models.dev may already include prefixes like us., eu., global., etc.
          const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]
          if (crossRegionPrefixes.some((prefix) => modelID.startsWith(prefix))) {
            return sdk.languageModel(modelID)
          }

          // Region resolution precedence (highest to lowest):
          // 1. options.region from merakcode.json provider config
          // 2. defaultRegion from AWS_REGION environment variable
          // 3. Default "us-east-1" (baked into defaultRegion)
          const region = options?.region ?? defaultRegion

          let regionPrefix = region.split("-")[0]

          switch (regionPrefix) {
            case "us": {
              const modelRequiresPrefix = [
                "nova-micro",
                "nova-lite",
                "nova-pro",
                "nova-premier",
                "nova-2",
                "claude",
                "deepseek",
              ].some((m) => modelID.includes(m))
              const isGovCloud = region.startsWith("us-gov")
              if (modelRequiresPrefix && !isGovCloud) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "eu": {
              const regionRequiresPrefix = [
                "eu-west-1",
                "eu-west-2",
                "eu-west-3",
                "eu-north-1",
                "eu-central-1",
                "eu-south-1",
                "eu-south-2",
              ].some((r) => region.includes(r))
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                modelID.includes(m),
              )
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "ap": {
              const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
              const isTokyoRegion = region === "ap-northeast-1"
              if (
                isAustraliaRegion &&
                ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
              ) {
                regionPrefix = "au"
                modelID = `${regionPrefix}.${modelID}`
              } else if (isTokyoRegion) {
                // Tokyo region uses jp. prefix for cross-region inference
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "jp"
                  modelID = `${regionPrefix}.${modelID}`
                }
              } else {
                // Other APAC regions use apac. prefix
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "apac"
                  modelID = `${regionPrefix}.${modelID}`
                }
              }
              break
            }
          }

          return sdk.languageModel(modelID)
        },
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
    vercel: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "http-referer": Project.HOMEPAGE,
            "x-title": Project.NAME,
          },
        },
      }
    },
    "google-vertex": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "us-east5"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "google-vertex-anthropic": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "sap-ai-core": async () => {
      const auth = await Auth.get("sap-ai-core")
      // TODO: Using process.env directly because Env.set only updates a shallow copy (not process.env),
      // until the scope of the Env API is clarified (test only or runtime?)
      const envServiceKey = iife(() => {
        const envAICoreServiceKey = process.env.AICORE_SERVICE_KEY
        if (envAICoreServiceKey) return envAICoreServiceKey
        if (auth?.type === "api") {
          process.env.AICORE_SERVICE_KEY = auth.key
          return auth.key
        }
        return undefined
      })
      const deploymentId = process.env.AICORE_DEPLOYMENT_ID
      const resourceGroup = process.env.AICORE_RESOURCE_GROUP

      return {
        autoload: !!envServiceKey,
        options: envServiceKey ? { deploymentId, resourceGroup } : {},
        async getModel(sdk: any, modelID: string) {
          return sdk(modelID)
        },
      }
    },
    zenmux: async () => {
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
    gitlab: async (input) => {
      const instanceUrl = Env.get("GITLAB_INSTANCE_URL") || "https://gitlab.com"

      const auth = await Auth.get(input.id)
      const apiKey = await (async () => {
        if (auth?.type === "oauth") return auth.access
        if (auth?.type === "api") return auth.key
        return Env.get("GITLAB_TOKEN")
      })()

      const config = await Config.get()
      const providerConfig = config.provider?.["gitlab"]

      const aiGatewayHeaders = {
        "User-Agent": `merakcode/${Installation.VERSION} gitlab-ai-provider/${GITLAB_PROVIDER_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
        ...(providerConfig?.options?.aiGatewayHeaders || {}),
      }

      return {
        autoload: !!apiKey,
        options: {
          instanceUrl,
          apiKey,
          aiGatewayHeaders,
          featureFlags: {
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: true,
            ...(providerConfig?.options?.featureFlags || {}),
          },
        },
        async getModel(sdk: ReturnType<typeof createGitLab>, modelID: string) {
          return sdk.agenticChat(modelID, {
            aiGatewayHeaders,
            featureFlags: {
              duo_agent_platform_agentic_chat: true,
              duo_agent_platform: true,
              ...(providerConfig?.options?.featureFlags || {}),
            },
          })
        },
      }
    },
    "cloudflare-workers-ai": async (input) => {
      const accountId = Env.get("CLOUDFLARE_ACCOUNT_ID")
      if (!accountId) return { autoload: false }

      const apiKey = await iife(async () => {
        const envToken = Env.get("CLOUDFLARE_API_KEY")
        if (envToken) return envToken
        const auth = await Auth.get(input.id)
        if (auth?.type === "api") return auth.key
        return undefined
      })

      return {
        autoload: !!apiKey,
        options: {
          apiKey,
          baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
        },
        async getModel(sdk: any, modelID: string) {
          return sdk.languageModel(modelID)
        },
      }
    },
    "cloudflare-ai-gateway": async (input) => {
      const accountId = Env.get("CLOUDFLARE_ACCOUNT_ID")
      const gateway = Env.get("CLOUDFLARE_GATEWAY_ID")

      if (!accountId || !gateway) return { autoload: false }

      // Get API token from env or auth - required for authenticated gateways
      const apiToken = await (async () => {
        const envToken = Env.get("CLOUDFLARE_API_TOKEN") || Env.get("CF_AIG_TOKEN")
        if (envToken) return envToken
        const auth = await Auth.get(input.id)
        if (auth?.type === "api") return auth.key
        return undefined
      })()

      if (!apiToken) {
        throw new Error(
          await Text.pick({
            zh: "Cloudflare AI Gateway 需要 CLOUDFLARE_API_TOKEN 或 CF_AIG_TOKEN，请通过环境变量配置。",
            en: "Cloudflare AI Gateway requires CLOUDFLARE_API_TOKEN or CF_AIG_TOKEN; set it as an environment variable.",
          }),
        )
      }

      // Use official ai-gateway-provider package (v2.x for AI SDK v5 compatibility)
      const { createAiGateway } = await import("ai-gateway-provider")
      const { createUnified } = await import("ai-gateway-provider/providers/unified")

      const aigateway = createAiGateway({ accountId, gateway, apiKey: apiToken })
      const unified = createUnified()

      return {
        autoload: true,
        async getModel(_sdk: any, modelID: string, _options?: Record<string, any>) {
          // Model IDs use Unified API format: provider/model (e.g., "anthropic/claude-sonnet-4-5")
          return aigateway(unified(modelID))
        },
        options: {},
      }
    },
    cerebras: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "merakcode",
          },
        },
      }
    },
  }

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
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
      reasoning_options: z.array(ReasoningOption).optional(),
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
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    const m: Model = {
      id: model.id,
      providerID: provider.id,
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: model.provider?.api ?? provider.api!,
        npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0,
        },
        experimentalOver200K: model.cost?.context_over_200k
          ? {
              cache: {
                read: model.cost.context_over_200k.cache_read ?? 0,
                write: model.cost.context_over_200k.cache_write ?? 0,
              },
              input: model.cost.context_over_200k.input,
              output: model.cost.context_over_200k.output,
            }
          : undefined,
      },
      limit: {
        context: model.limit.context,
        input: model.limit.input,
        output: model.limit.output,
      },
      capabilities: {
        temperature: model.temperature,
        reasoning: model.reasoning,
        attachment: model.attachment,
        toolcall: model.tool_call,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
      release_date: model.release_date,
      reasoning_options: model.reasoning_options,
      variants: {},
    }

    m.variants = mapValues(ProviderTransform.variants(m), (v) => v)

    return m
  }

  export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
    return {
      id: provider.id,
      source: "custom",
      name: provider.name,
      env: provider.env ?? [],
      options: {},
      models: mapValues(provider.models, (model) => fromModelsDevModel(provider, model)),
    }
  }

  /** Sorts providers by name for the /provider and /config/providers lists */
  export function sortProvidersByPriority<T extends { id: string; name?: string }>(providers: readonly T[]): T[] {
    return sortBy(providers, [(p) => p.name ?? p.id, "asc"])
  }

  /** Order of common providers, matching the desktop connect-provider dialog */
  const PREFERRED = [
    "alibaba-cn",
    "zhipuai",
    "moonshotai-cn",
    "deepseek",
    "siliconflow-cn",
    "openai",
    "anthropic",
    "openrouter",
    "google",
    "xai",
  ]

  /**
   * Order of connected providers; the default model comes from the first one. Providers the user configured (saved
   * key, login, config file) come before those detected from environment variables, because one variable often
   * connects several providers while the key works for only one of them. Then common order, then name.
   */
  export function rank<T extends Pick<Info, "id" | "name" | "source">>(providers: readonly T[]): T[] {
    const preferred = (p: T) => (PREFERRED.includes(p.id) ? PREFERRED.indexOf(p.id) : PREFERRED.length)
    return sortBy(providers, [(p) => (p.source === "env" ? 1 : 0), "asc"], [preferred, "asc"], [(p) => p.name, "asc"])
  }

  /**
   * ModelsDev catalog filtered by enabled/disabled, used by the API list and available-provider logic.
   * Same source as `all` in GET `/` of `server/routes/provider` (without the `connected` merge).
   */
  export async function getFilteredProviders(): Promise<Record<string, ModelsDev.Provider>> {
    const config = await Config.get()
    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
    const allProviders = await ModelsDev.get()
    return Object.fromEntries(
      Object.entries(allProviders).filter(([key]) => (enabled ? enabled.has(key) : true) && !disabled.has(key)),
    )
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
    const modelsDev = await ModelsDev.get()
    log.info("provider.models.completed", {
      duration: Date.now() - modelsStarted,
      providers: Object.keys(modelsDev).length,
    })

    const mapStarted = Date.now()
    const database = mapValues(modelsDev, fromModelsDevProvider)
    // GitHub Copilot only works with GitHub's own sign-in flow, which MerakCode does not ship
    for (const id of ["github-copilot", "github-copilot-enterprise"]) delete database[id]
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
        models: existing?.models ?? {},
      }

      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        const existingModel = parsed.models[model.id ?? modelID]
        const name = iife(() => {
          if (model.name) return model.name
          if (model.id && model.id !== modelID) return modelID
          return existingModel?.name ?? modelID
        })
        const parsedModel: Model = {
          id: modelID,
          api: {
            id: model.id ?? existingModel?.api.id ?? modelID,
            npm:
              model.provider?.npm ??
              provider.npm ??
              existingModel?.api.npm ??
              modelsDev[providerID]?.npm ??
              "@ai-sdk/openai-compatible",
            url: model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
          },
          status: model.status ?? existingModel?.status ?? "active",
          name,
          providerID,
          capabilities: {
            temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
            reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
            attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
            toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
            input: {
              text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
              audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
              image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
              video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
              pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
            },
            output: {
              text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
              audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
              image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
              video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
              pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
            },
            interleaved: model.interleaved ?? false,
          },
          cost: {
            input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
            output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
            cache: {
              read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
              write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
            },
          },
          options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
          limit: {
            context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
            output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
          },
          headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
          family: model.family ?? existingModel?.family ?? "",
          release_date: model.release_date ?? existingModel?.release_date ?? "",
          reasoning_options: model.reasoning_options ?? existingModel?.reasoning_options,
          variants: {},
        }
        const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
        parsedModel.variants = mapValues(
          pickBy(merged, (v) => !v.disabled),
          (v) => omit(v, ["disabled"]),
        )
        parsed.models[modelID] = parsedModel
      }
      database[providerID] = parsed
    }

    // load env
    const env = Env.all()
    for (const [providerID, provider] of Object.entries(database)) {
      if (disabled.has(providerID)) continue
      const apiKey = provider.env.map((item) => env[item]).find(Boolean)
      if (!apiKey) continue
      mergeProvider(providerID, {
        source: "env",
        key: provider.env.length === 1 ? apiKey : undefined,
      })
    }

    // load apikeys
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

      // Without usable credentials the provider is not listed, so custom models without a key never appear.
      // Hosted official providers, Bedrock profiles, etc. pass via loaderAuthorized; multi-env providers may not set
      // provider.key
      const optionKey = provider.options?.apiKey
      const hasApiKey = !!(provider.key || (typeof optionKey === "string" && optionKey.length > 0))
      const hasAuthFetch = typeof provider.options?.fetch === "function"
      const hasEnvCredential = (provider.env ?? []).some((name) => Boolean(Env.get(name) || env[name]))
      if (!hasApiKey && !hasAuthFetch && !hasEnvCredential && !loaderAuthorized.has(providerID)) {
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

        model.variants = mapValues(ProviderTransform.variants(model), (v) => v)

        // Custom provider models lack models.dev reasoning_options: an off variant means thinking can be toggled, so
        // derive the toggle capability for the desktop switch.
        if (!model.reasoning_options?.length && model.variants?.["off"]) {
          model.reasoning_options = [{ type: "toggle" }]
        }

        // Filter out disabled variants from config
        const configVariants = configProvider?.models?.[modelID]?.variants
        if (configVariants && model.variants) {
          const merged = mergeDeep(model.variants, configVariants)
          model.variants = mapValues(
            pickBy(merged, (v) => !v.disabled),
            (v) => omit(v, ["disabled"]),
          )
        }

        // Checked after the config merge: models without off/on variants expose no toggle, so the desktop shows no fake
        // switch
        if (model.reasoning_options?.length) {
          const hasToggleVariant = ["off", "on"].some((key) => key in (model.variants ?? {}))
          if (!hasToggleVariant) {
            model.reasoning_options = model.reasoning_options.filter((option) => option.type !== "toggle")
          }
        }
      }

      if (Object.keys(provider.models).length === 0) {
        delete providers[providerID]
        continue
      }

      log.info("found", { providerID })
    }

    // Whole provider catalogs registered by plugins are merged after the models.dev providers are admitted and
    // filtered; plugins own access control for their catalogs, but the user's disabled_providers still applies.
    const custom = await Plugin.customProviders()
    for (const [providerID, provider] of Object.entries(custom)) {
      if (disabled.has(providerID)) continue
      providers[providerID] = provider
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
          Object.entries(next).map(([modelID, model]) => [modelID, { ...model, id: modelID, providerID }]),
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

  /** Collects the environment variable names of all providers; the single source of keys for Env.reload() */
  export async function getAllEnvKeys(): Promise<string[]> {
    const modelsDev = await ModelsDev.get()
    return [...new Set(Object.values(modelsDev).flatMap((provider) => provider.env))]
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
        // IDs are only re-attached for Azure with store=true
        if (model.api.npm === "@ai-sdk/openai" && opts.body && opts.method === "POST") {
          const body = JSON.parse(opts.body as string)
          const isAzure = model.providerID.includes("azure")
          const keepIds = isAzure && body.store === true
          if (!keepIds && Array.isArray(body.input)) {
            for (const item of body.input) {
              if ("id" in item) {
                delete item.id
              }
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
        if (providerID === "amazon-bedrock") {
          const crossRegionPrefixes = ["global.", "us.", "eu."]
          const candidates = Object.keys(provider.models).filter((m) => m.includes(item))

          // Model selection priority:
          // 1. global. prefix (works everywhere)
          // 2. User's region prefix (us., eu.)
          // 3. Unprefixed model
          const globalMatch = candidates.find((m) => m.startsWith("global."))
          if (globalMatch) return getModel(providerID, globalMatch)

          const region = provider.options?.region
          if (region) {
            const regionPrefix = region.split("-")[0]
            if (regionPrefix === "us" || regionPrefix === "eu") {
              const regionalMatch = candidates.find((m) => m.startsWith(`${regionPrefix}.`))
              if (regionalMatch) return getModel(providerID, regionalMatch)
            }
          }

          const unprefixed = candidates.find((m) => !crossRegionPrefixes.some((p) => m.startsWith(p)))
          if (unprefixed) return getModel(providerID, unprefixed)
        } else {
          for (const model of Object.keys(provider.models)) {
            if (model.includes(item)) return getModel(providerID, model)
          }
        }
      }
    }
    return undefined
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
    const recent = (await Filesystem.readJson(path.join(Global.Path.state, "model.json"))
      .then((x) => (Array.isArray(x.recent) ? x.recent : []))
      .catch(() => [])) as { providerID: string; modelID: string }[]
    for (const entry of recent) {
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
