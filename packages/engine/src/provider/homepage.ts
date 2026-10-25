import { HOMEPAGE_LINES } from "./official"
import type { Provider } from "./provider"

const STATUS = new Set(["preview"])
const SIZE = /^(?:a?\d+(?:\.\d+)?b|\d+k)$/

/** Words that mark speech, image, embedding, or live models, which stay off the homepage by default. */
const NON_CHAT = new Set([
  "embed",
  "embedding",
  "embeddings",
  "tts",
  "whisper",
  "transcribe",
  "transcription",
  "speech",
  "asr",
  "realtime",
  "live",
  "image",
  "imagen",
])

type Picker = { include?: string[]; exclude?: string[] }

/** Words left after the version is pulled out. A single letter in front of a number is the version, not a tier. */
function lineOf(id: string) {
  let tokens = id.toLowerCase().split("-").filter(Boolean)
  if (tokens.length >= 3 && date(tokens.slice(-3).join("-"))) tokens = tokens.slice(0, -3)
  if (tokens.length && date(tokens.at(-1)!)) tokens = tokens.slice(0, -1)
  tokens = tokens.filter((token) => !STATUS.has(token))

  const words: string[] = []
  const version: number[] = []
  let took = false
  let sized = false
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (SIZE.test(token)) {
      sized = true
      continue
    }
    if (took) {
      if (!/^\d+$/.test(token)) words.push(token)
      continue
    }
    if (/^\d+\.\d+$/.test(token)) {
      version.push(...token.split(".").map(Number))
      took = true
      continue
    }
    if (/^\d+$/.test(token) && token.length < 8) {
      while (index < tokens.length && /^\d+$/.test(tokens[index]) && tokens[index].length < 8) {
        version.push(Number(tokens[index]))
        index++
      }
      index--
      took = true
      continue
    }
    const mixed = token.match(/^([a-z]+)(\d+(?:\.\d+)*)$/)
    if (mixed) {
      if (mixed[1].length > 1) words.push(mixed[1])
      version.push(...mixed[2].split(".").map(Number))
      took = true
      continue
    }
    const glued = token.match(/^(\d+(?:\.\d+)*)([a-z]+)$/)
    if (glued) {
      version.push(...glued[1].split(".").map(Number))
      words.push(glued[2])
      took = true
      continue
    }
    words.push(token)
  }
  return { words, version, sized }
}

function date(value: string) {
  const match = value.match(/^(\d{4})-?(\d{2})-?(\d{2})$/)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return year >= 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31
}

function newer(left: number[], right: number[]) {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return false
}

function chat(model: Provider.Model) {
  if (model.status === "deprecated" || model.capabilities.toolcall === false) return false
  const tokens = model.id.toLowerCase().split(/[^a-z0-9]+/)
  return !tokens.some((token) => NON_CHAT.has(token)) && !model.id.toLowerCase().includes("dall-e")
}

/** The unsuffixed id is the rolling name. Otherwise the higher version wins, and a tie keeps the shorter id. */
function preferred(next: Provider.Model, current: Provider.Model) {
  const incoming = lineOf(next.id)
  const kept = lineOf(current.id)
  const incomingBare = incoming.version.length === 0
  const keptBare = kept.version.length === 0
  if (incomingBare !== keptBare) return incomingBare
  if (!incomingBare && (newer(incoming.version, kept.version) || newer(kept.version, incoming.version))) {
    return newer(incoming.version, kept.version)
  }
  return next.id.length < current.id.length
}

/** Model ids that are on the homepage before the user's include and exclude lists. */
function homepageDefaults(origin: Provider.Info["origin"], models: Provider.Model[], providerID: string) {
  if (origin !== "official") return new Set(models.map((model) => model.id))
  const rule = HOMEPAGE_LINES[providerID as keyof typeof HOMEPAGE_LINES]
  if (!rule) return new Set<string>()
  const eligible = models.filter((model) => chat(model) && !lineOf(model.id).sized)
  const exact = rule.exact
  if (exact) return new Set(eligible.filter((model) => exact.includes(model.id)).map((model) => model.id))
  const tiers = new Set(rule.tiers ?? [])
  const best = new Map<string, Provider.Model>()
  for (const model of eligible) {
    const tier = lineOf(model.id).words.slice(1).join("-")
    if (!tiers.has(tier)) continue
    const current = best.get(tier)
    if (!current || preferred(model, current)) best.set(tier, model)
  }
  return new Set([...best.values()].map((model) => model.id))
}

/** Writes homepage from the default set and the user's include/exclude delta. */
export function applyHomepage(provider: Provider.Info, picker?: Picker) {
  const include = new Set(picker?.include ?? [])
  const exclude = new Set(picker?.exclude ?? [])
  const defaults = homepageDefaults(provider.origin, Object.values(provider.models), provider.id)
  for (const [id, model] of Object.entries(provider.models)) {
    model.homepage = (defaults.has(id) && !exclude.has(id)) || include.has(id)
  }
}
