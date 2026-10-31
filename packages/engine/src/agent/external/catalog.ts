import { z } from "zod"
import { Config } from "@merakcode/engine/agent/settings/index"
import { Text } from "../prompt/text"
import { adapterOf } from "./adapters"
import { inspectMember, stopProduct } from "./runtime"
import { productState, onDisable } from "./state"
import type { Info } from "@merakcode/sdk/adapter"

onDisable(stopProduct)

export type ProductSpec = Config.AgentConnectionProduct & { id: string; title: string; command: string; args: string[] }

export const BUILTIN_PRODUCTS: ProductSpec[] = [
  { id: "claude", title: "Claude Code", command: "claude", adapter: "claude", args: [] },
  { id: "codex", title: "Codex", command: "codex", adapter: "codex", args: [] },
  { id: "opencode", title: "OpenCode", command: "opencode", adapter: "opencode", args: [] },
]

const Capabilities = z.object({
  modelSelection: z.boolean(),
  modelDiscovery: z.boolean(),
  textStreaming: z.boolean(),
  resume: z.boolean(),
  permission: z.enum(["merak", "external"]),
  questions: z.boolean(),
})

export const Product = Config.AgentConnectionProduct.extend({
  id: z.string(),
  title: z.string(),
  enabled: z.boolean(),
  connected: z.boolean(),
  reason: z.string().optional(),
  builtin: z.boolean(),
  source: z.enum(["builtin", "global"]),
  revision: z.number(),
  version: z.string().optional(),
  path: z.string().optional(),
  recommended: z.string().optional(),
  upgrade: z.string().optional(),
  outdated: z.boolean().optional(),
  capabilities: Capabilities,
}).meta({ ref: "AgentConnectionProduct" })

const unsupported = {
  modelSelection: false,
  modelDiscovery: false,
  textStreaming: false,
  resume: false,
  permission: "external" as const,
  questions: false,
}

export async function configuredProducts(): Promise<ProductSpec[]> {
  const configured = (await Config.getGlobal()).agentConnections?.products ?? {}
  const list = new Map(BUILTIN_PRODUCTS.map((product) => [product.id, product]))
  for (const [id, fields] of Object.entries(configured)) {
    if (id === "merak") continue
    const base = list.get(id) ?? { id, title: id, command: "", args: [] }
    list.set(id, {
      ...base,
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      id,
    })
  }
  return [...list.values()]
}

export function titleOf(products: readonly ProductSpec[]) {
  return (id: string) => (id === "merak" ? "MerakCode" : (products.find((product) => product.id === id)?.title ?? id))
}

async function probe(product: ProductSpec, options: { refresh?: boolean } = {}): Promise<Partial<Info>> {
  let driven: Awaited<ReturnType<typeof adapterOf>>
  try {
    driven = await adapterOf(product)
  } catch (error) {
    return {
      unavailable: error instanceof Config.InvalidError ? (error.data.message ?? error.message) : String(error),
    }
  }
  if (!driven)
    return {
      unavailable: await Text.pick({ zh: `${product.command} 未安装`, en: `${product.command} is not installed` }),
    }
  const key = JSON.stringify(driven)
  const cached = probes.get(key)
  if (cached && !options.refresh && Date.now() - cached.at < 60_000) return cached.result
  const result = inspectMember({ ...driven, cwd: process.cwd() }).catch((error: Error) => ({
    unavailable: error.message,
  }))
  probes.set(key, { at: Date.now(), result })
  return result
}

export async function products(options: { refresh?: boolean } = {}): Promise<z.infer<typeof Product>[]> {
  for (;;) {
    const snapshot = await Config.getGlobal()
    const configured = snapshot.agentConnections?.products ?? {}
    const list = await Promise.all(
      (await configuredProducts()).map(async (product) => {
        const info: Partial<Info> =
          product.enabled === false
            ? { unavailable: await Text.pick({ zh: "已关闭", en: "Disabled" }) }
            : await probe(product, options)
        return {
          ...product,
          enabled: product.enabled !== false,
          connected: !info.unavailable,
          reason: info.unavailable,
          builtin: BUILTIN_PRODUCTS.some((item) => item.id === product.id),
          source: product.id in configured ? ("global" as const) : ("builtin" as const),
          revision: (await productState(product.id)).revision,
          capabilities: info.capabilities ?? unsupported,
          version: info.version,
          path: info.path,
          recommended: info.recommended,
          upgrade: info.upgrade,
          outdated: !!info.version && !!info.recommended && older(info.version, info.recommended),
        }
      }),
    )
    // A probe can outlive a configuration change; its fields and revision must belong to the same snapshot.
    if ((await Config.getGlobal()) !== snapshot) continue
    return [
      {
        id: "merak",
        title: "MerakCode",
        enabled: true,
        connected: true,
        builtin: true,
        source: "builtin",
        revision: 0,
        capabilities: unsupported,
      },
      ...list,
    ]
  }
}

function older(version: string, recommended: string) {
  const numbers = (value: string) =>
    /(\d+)\.(\d+)(?:\.(\d+))?/
      .exec(value)
      ?.slice(1, 4)
      .map((part) => Number(part ?? 0))
  const have = numbers(version)
  const want = numbers(recommended)
  if (!have || !want) return false
  for (let index = 0; index < 3; index++) if (have[index] !== want[index]) return have[index]! < want[index]!
  return false
}

const probes = new Map<string, { at: number; result: Promise<Partial<Info>> }>()
