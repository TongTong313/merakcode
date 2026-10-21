import { Global } from "../global"
import { Log } from "@merakcode/log/logger"
import path from "path"
import z from "zod"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { lazy } from "../util/lazy"
import { withTrustedTls } from "@merakcode/util/tls"
import { Filesystem } from "@merakcode/util/filesystem"
import { selectOfficial } from "./official"

// Try to import bundled snapshot (generated at build time)
// Falls back to undefined in dev mode when snapshot doesn't exist
/* @ts-ignore */

/** One models.dev reasoning_options entry */
export const ReasoningOption = z.union([
  z.object({ type: z.literal("toggle") }),
  z.object({ type: z.literal("effort"), values: z.array(z.string()) }),
  z.object({
    type: z.literal("budget_tokens"),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
])
export type ReasoningOption = z.infer<typeof ReasoningOption>

export namespace ModelsDev {
  const log = Log.create({ service: "models.dev" })
  const filepath = path.join(Global.Path.cache, "models.json")

  export const Model = z.object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    release_date: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    temperature: z.boolean(),
    tool_call: z.boolean(),
    interleaved: z
      .union([
        z.literal(true),
        z
          .object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          })
          .strict(),
      ])
      .optional(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
        context_over_200k: z
          .object({
            input: z.number(),
            output: z.number(),
            cache_read: z.number().optional(),
            cache_write: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    limit: z.object({
      context: z.number(),
      input: z.number().optional(),
      output: z.number(),
    }),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      })
      .optional(),
    experimental: z.boolean().optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    options: z.record(z.string(), z.any()),
    headers: z.record(z.string(), z.string()).optional(),
    provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
    variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    reasoning_options: z.array(ReasoningOption).optional(),
  })
  export type Model = z.infer<typeof Model>

  export const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), Model),
  })

  export type Provider = z.infer<typeof Provider>

  function url() {
    return Flag.MERAKCODE_MODELS_URL || "https://models.dev"
  }

  export const Data = lazy(async () => {
    const result = await Filesystem.readJson(Flag.MERAKCODE_MODELS_PATH ?? filepath).catch(() => {})
    if (result) return result
    // @ts-ignore
    const snapshot = await import("./models-snapshot")
      .then((m) => m.snapshot as Record<string, unknown>)
      .catch(() => undefined)
    if (snapshot) return snapshot
    if (Flag.MERAKCODE_DISABLE_MODELS_FETCH) return {}
    // Cold path (no local cache, no snapshot) fetches over the network: use the same short timeout as refresh() so a
    // hang cannot leave the UI blank
    const MODELS_DEV_COLD_FETCH_TIMEOUT_MS = 10_000
    let json: string | undefined
    try {
      // Must use withTrustedTls: a bare fetch is undermined by a global NODE_TLS_REJECT_UNAUTHORIZED=0, letting a man
      // in the middle with a self-signed certificate impersonate the catalog and tamper with providers and endpoints.
      json = await fetch(
        `${url()}/api.json`,
        withTrustedTls({ signal: AbortSignal.timeout(MODELS_DEV_COLD_FETCH_TIMEOUT_MS) }),
      ).then((x) => x.text())
    } catch (e) {
      log.error("Failed to fetch models.dev", { error: e, timeoutMs: MODELS_DEV_COLD_FETCH_TIMEOUT_MS })
      json = undefined
    }
    if (!json) return {}
    return JSON.parse(json)
  })

  export async function get() {
    const result = await Data()
    return selectOfficial(result as Record<string, Provider>)
  }

  /** Fetches the latest model catalog into the cache; returns false and keeps the old cache if that fails */
  export async function refresh() {
    let result: Response | undefined
    try {
      // As above: only withTrustedTls overrides a global NODE_TLS_REJECT_UNAUTHORIZED=0
      result = await fetch(
        `${url()}/api.json`,
        withTrustedTls({
          headers: {
            "User-Agent": Installation.USER_AGENT,
          },
          signal: AbortSignal.timeout(10 * 1000),
        }),
      )
    } catch (e) {
      log.error("Failed to fetch models.dev", {
        error: e,
      })
      result = undefined
    }
    if (!result?.ok) return false
    // Background refresh: failures reading the response or writing the cache are only logged; the old cache stays
    const written = await result
      .text()
      .then((text) => Filesystem.write(filepath, JSON.stringify(selectOfficial(JSON.parse(text)))))
      .then(
        () => true,
        (error: unknown) => {
          log.error("Failed to cache models.dev", { error })
          return false
        },
      )
    if (written) ModelsDev.Data.reset()
    return written
  }
}

if (!Flag.MERAKCODE_DISABLE_MODELS_FETCH) {
  ModelsDev.refresh()
  setInterval(
    async () => {
      await ModelsDev.refresh()
    },
    60 * 1000 * 60,
  ).unref()
}
