import path from "path"
import { Log } from "@merakcode/log/logger"
import { Filesystem } from "@merakcode/util/filesystem"
import { Global } from "../global"
import type { Provider } from "./provider"
import { ProviderTransform } from "./transform"
import { OFFICIAL, PUBLIC_EFFORT_PROVIDERS, official } from "./official"
import { CatalogRequestError } from "./catalog/http"
import { CatalogFile, parseItems, type CatalogModel } from "./catalog/model"
import { matchFallback, matchPublic, normalizeModelID } from "./catalog/match"
import { FALLBACK, type FallbackEntry } from "./catalog/fallback"
import * as DeepSeek from "./catalog/deepseek"
import * as Alibaba from "./catalog/alibaba"
import * as OpenRouter from "./catalog/openrouter"
import * as Anthropic from "./catalog/anthropic"
import * as OpenAI from "./catalog/openai"
import * as Google from "./catalog/google"
import * as Moonshot from "./catalog/moonshot"
import * as Zhipu from "./catalog/zhipu"

export { CatalogModel as Model } from "./catalog/model"
export { fromConfig, extras as configExtras } from "./catalog/config"
export { parseList as parseRelay } from "./catalog/relay"
export { FALLBACK, normalizeModelID, matchPublic as lookup }

const log = Log.create({ service: "catalog" })

const HOUR = 60 * 60 * 1000

type Adapter = {
  fetch: (input: { url: string; key: string }) => Promise<unknown[]>
  parse: (item: unknown, publicIDs?: ReadonlySet<string>) => CatalogModel | undefined
}

const ADAPTERS: Record<string, Adapter> = {
  deepseek: DeepSeek,
  "alibaba-cn": Alibaba,
  openrouter: OpenRouter,
  anthropic: Anthropic,
  openai: OpenAI,
  google: Google,
  "moonshotai-cn": Moonshot,
  zhipuai: Zhipu,
}

function defined<T>(values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined)
}

/** Undeclared modalities still allow text in and out, or no message could be sent. */
function modalities(values: CatalogModel["input"] | undefined) {
  const present = new Set(values ?? [])
  return {
    text: values ? present.has("text") : true,
    audio: present.has("audio"),
    image: present.has("image"),
    video: present.has("video"),
    pdf: present.has("pdf"),
  }
}

type Price = { input: number; output: number; cacheRead?: number; cacheWrite?: number }

function rate(price: Price) {
  return {
    input: price.input,
    output: price.output,
    cache: { read: price.cacheRead ?? 0, write: price.cacheWrite ?? 0 },
  }
}

function costOf(price: NonNullable<CatalogModel["cost"]>): NonNullable<Provider.Model["cost"]> {
  return {
    ...rate(price),
    currency: price.currency,
    tiers: price.tiers?.map((tier) => ({
      above: tier.above,
      ...rate(tier),
      thinking: tier.thinking && rate(tier.thinking),
    })),
    thinking: price.thinking && rate(price.thinking),
  }
}

export type MergeInput = {
  providerID: string
  npm: string
  url: string
  interleaved: false | { field: "reasoning_content" | "reasoning_details" }
  official?: CatalogModel
  public?: CatalogModel
  fallback?: FallbackEntry
  config?: Partial<CatalogModel>
  apiID?: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
  family?: string
  configInterleaved?: false | { field: "reasoning_content" | "reasoning_details" }
}

/** The only place a Provider.Model is built from catalog data. */
export function toProviderModel(input: MergeInput): Provider.Model {
  const config = input.config
  const officialModel = input.official
  const pub = input.public
  const fallback = input.fallback
  const id = config?.id ?? officialModel?.id ?? pub?.id ?? "model"
  // Gateway levels use the vendor's own parameter names only for Anthropic, OpenAI and Google. A relay or custom
  // provider is judged by the vendor of the matched public entry.
  const vendor = official(input.providerID) ? input.providerID : pub?.id.split("/")[0]
  const gateway = PUBLIC_EFFORT_PROVIDERS.has(vendor ?? "")
  const efforts = defined([
    config?.efforts,
    officialModel?.efforts,
    gateway ? pub?.efforts : undefined,
    fallback?.efforts,
  ])
  const canDisable = defined([
    config?.canDisable,
    officialModel?.canDisable,
    gateway ? pub?.canDisable : undefined,
    fallback?.canDisable,
  ])
  const defaultEffort = defined([
    config?.defaultEffort,
    officialModel?.defaultEffort,
    fallback?.defaultEffort,
    pub?.defaultEffort,
  ])
  const priced = input.providerID === "openrouter" || input.providerID === "alibaba-cn"
  const price = config?.cost ?? (priced ? officialModel?.cost : undefined)
  const inputMods = defined([config?.input, officialModel?.input, pub?.input])
  const outputMods = defined([config?.outputModalities, officialModel?.outputModalities, pub?.outputModalities])
  const reasoning = defined([config?.reasoning, officialModel?.reasoning, pub?.reasoning]) ?? false
  const inputCaps = modalities(inputMods)
  const outputCaps = modalities(outputMods)
  const model: Provider.Model = {
    id,
    providerID: input.providerID,
    name: defined([config?.name, officialModel?.name, pub?.name]) ?? id,
    family: input.family,
    api: { id: input.apiID ?? id, url: input.url, npm: input.npm },
    status: defined([config?.status, officialModel?.status, pub?.status]) ?? "active",
    headers: input.headers ?? {},
    options: input.options ?? {},
    cost: price ? costOf(price) : undefined,
    limit: {
      context: defined([config?.context, officialModel?.context, pub?.context, fallback?.context]) ?? 0,
      output: defined([config?.output, officialModel?.output, pub?.output, fallback?.output]) ?? 0,
    },
    capabilities: {
      temperature:
        defined([config?.temperature, officialModel?.temperature, pub?.temperature, fallback?.temperature]) ?? true,
      reasoning,
      attachment: inputCaps.image || inputCaps.pdf || inputCaps.audio || inputCaps.video,
      toolcall: defined([config?.toolcall, officialModel?.toolcall, pub?.toolcall]) ?? true,
      input: inputCaps,
      output: outputCaps,
      interleaved: input.configInterleaved ?? input.interleaved,
    },
    release_date: defined([config?.releaseDate, officialModel?.releaseDate, pub?.releaseDate]) ?? "",
    variants: {},
  }
  ProviderTransform.fillVariants(model, { efforts, canDisable, defaultEffort })
  return model
}

function file(name: string) {
  return path.join(Global.Path.cache, "catalog", `${name}.json`)
}

async function load(name: string) {
  const parsed = CatalogFile.safeParse(await Filesystem.readJson(file(name)).catch(() => undefined))
  return parsed.success ? parsed.data : undefined
}

/** Cached models of one provider, or of the public catalog when name is "public". */
export async function read(name: string): Promise<CatalogModel[]> {
  return (await load(name))?.models ?? []
}

export function readPublic() {
  return read("public")
}

async function write(name: string, models: CatalogModel[]) {
  const body: CatalogFile = { fetchedAt: Date.now(), models }
  await Filesystem.write(file(name), JSON.stringify(body))
}

/** One catalog fetch. A failure leaves the previous file in place and carries a message with no API key. */
export type RefreshResult = { ok: true } | { ok: false; message: string; statusCode?: number }

/** Fetches one list into the cache. A failure leaves the previous file in place. */
async function store(name: string, items: () => Promise<unknown[]>, parse: Adapter["parse"]): Promise<RefreshResult> {
  try {
    const models = parseItems(await items(), parse)
    await write(name, models)
    log.info("catalog refreshed", { name, models: models.length })
    return { ok: true }
  } catch (error) {
    log.error("catalog refresh failed", { name, error })
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      statusCode: error instanceof CatalogRequestError ? error.statusCode : undefined,
    }
  }
}

export function refresh(
  providerID: string,
  input: { key: string; baseURL: string; publicIDs?: ReadonlySet<string> },
): Promise<RefreshResult> {
  const adapter = ADAPTERS[providerID]
  if (!adapter || !official(providerID))
    return Promise.resolve({ ok: false, message: `no catalog adapter for ${providerID}` })
  return store(
    providerID,
    () => adapter.fetch({ url: input.baseURL, key: input.key }),
    (item) => adapter.parse(item, input.publicIDs),
  )
}

/** The keyless OpenRouter catalog. */
export function refreshPublic() {
  return store("public", () => OpenRouter.fetch({ url: OFFICIAL.openrouter.api, key: "" }), OpenRouter.parse)
}

export async function stale(name: string) {
  const fetched = (await load(name))?.fetchedAt
  return fetched === undefined || Date.now() - fetched > HOUR
}

export function publicIDs(models: readonly CatalogModel[]) {
  return new Set(models.map((model) => normalizeModelID(model.id)))
}

export function fallbackFor(providerID: string, id: string) {
  return matchFallback(FALLBACK, providerID, id)
}
