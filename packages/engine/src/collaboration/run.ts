import { isDeepEqual } from "remeda"
import { Config } from "../config/config"
import type { Text } from "@merakcode/util/text"
import { inspectMember } from "./member"
import type { Info } from "@merakcode/sdk/adapter"
import { adapterOf } from "./adapters"

export type ProductSpec = {
  id: string
  title: string
  command: string
  /** How MerakCode drives it; a product without one runs as a one-shot command */
  adapter?: "claude" | "codex" | "opencode" | "command" | "member"
  args: string[]
  /** Args appended when the seat already has a private session. The id is inserted where `{id}` appears. */
  resumeArgs?: string[]
  sessionLine?: string
  /** Offered for new members; turning it off leaves members already in a group working */
  enabled?: boolean
}

export const BUILTIN_PRODUCTS: ProductSpec[] = [
  // The built-in adapter starts the CLI with what it needs; args are only extra arguments from the user
  { id: "claude", title: "Claude Code", command: "claude", adapter: "claude", args: [] },
  { id: "codex", title: "Codex", command: "codex", adapter: "codex", args: [] },
  { id: "opencode", title: "OpenCode", command: "opencode", adapter: "opencode", args: [] },
]

/**
 * Built-in products merged with the ones in config.collaboration.products. An entry for a built-in id overrides only
 * the fields it sets; a new id starts from a one-shot command named after it.
 */
export async function configuredProducts() {
  const config = await Config.get()
  const byID = new Map(BUILTIN_PRODUCTS.map((product) => [product.id, product]))
  for (const [id, value] of Object.entries(config.collaboration?.products ?? {})) {
    const base: ProductSpec = byID.get(id) ?? { id, title: id, command: value.command ?? "", args: [] }
    const set = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined))
    byID.set(id, { ...base, ...set, id })
  }
  return [...byID.values()]
}

/**
 * Where a product's definition comes from: built in with nothing changed, the global config (editable in settings),
 * or a project's config, which settings only shows
 */
export async function productSources() {
  const [merged, global] = await Promise.all([Config.get(), Config.getGlobal()])
  const all = merged.collaboration?.products ?? {}
  const mine = global.collaboration?.products ?? {}
  return (id: string): "builtin" | "global" | "project" => {
    if (!(id in all)) return "builtin"
    return id in mine && isDeepEqual(mine[id], all[id]) ? "global" : "project"
  }
}

/** Display name of a product id, MerakCode included */
export function titleOf(products: readonly ProductSpec[]) {
  return (product: string) =>
    product === "merak" ? "MerakCode" : (products.find((item) => item.id === product)?.title ?? product)
}

/**
 * Whether a product can take a member: its command is on this machine and its adapter says the CLI can run. The
 * reason is in both languages; a CLI's own error text is the same in both.
 */
export async function probe(product: ProductSpec, options: { refresh?: boolean } = {}): Promise<Probe> {
  const driven = adapterOf(product)
  if (!driven)
    return { connected: false, reason: { zh: `${product.command} 未安装`, en: `${product.command} is not installed` } }
  // Checked once a minute at most, unless asked again: the list opens with every group, and installing a CLI takes
  // longer than that
  const key = JSON.stringify(driven)
  const cached = probes.get(key)
  if (cached && !options.refresh && Date.now() - cached.at < PROBE_TTL) return cached.result
  const result = inspectProbe(driven)
  probes.set(key, { at: Date.now(), result })
  return result
}

/** An adapter says itself what its CLI is: the handshake only, no task */
async function inspectProbe(driven: NonNullable<ReturnType<typeof adapterOf>>): Promise<Probe> {
  const info = await inspectMember({ ...driven, cwd: process.cwd() }).catch((error: Error): Partial<Info> => ({
    unavailable: error.message,
  }))
  const advice = { recommended: info.recommended, upgrade: info.upgrade }
  if (info.unavailable) return { connected: false, reason: { zh: info.unavailable, en: info.unavailable }, ...advice }
  return {
    connected: true,
    version: info.version,
    path: info.path,
    ...advice,
    outdated: !!info.version && !!info.recommended && older(info.version, info.recommended),
  }
}

/** Whether a version string (such as "codex-cli 0.77.0") is below recommended; one with no version number is not */
export function older(version: string, recommended: string) {
  const numbers = (text: string) =>
    /(\d+)\.(\d+)(?:\.(\d+))?/
      .exec(text)
      ?.slice(1, 4)
      .map((part) => Number(part ?? 0))
  const have = numbers(version)
  const want = numbers(recommended)
  if (!have || !want) return false
  for (let index = 0; index < 3; index++) if (have[index] !== want[index]) return have[index]! < want[index]!
  return false
}

/**
 * Whether the product can take a member, why not, and the version and path of the CLI found. An adapter can also
 * recommend a version: an older one still works, but is shown with how to upgrade.
 */
type Probe = {
  connected: boolean
  reason?: Text.Pair
  version?: string
  path?: string
  recommended?: string
  upgrade?: string
  outdated?: boolean
}
const PROBE_TTL = 60_000
const probes = new Map<string, { at: number; result: Promise<Probe> }>()
