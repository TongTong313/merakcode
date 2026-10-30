import z from "zod"

const Modality = z.enum(["text", "audio", "image", "video", "pdf"])
export type Modality = z.infer<typeof Modality>

const Price = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
})

/**
 * One model after a provider's list has been parsed. Optional fields are absent when the API did not send them;
 * adapters must not invent 0 or false. This is the only intermediate model shape.
 */
export const CatalogModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  context: z.number().optional(),
  output: z.number().optional(),
  input: z.array(Modality).optional(),
  outputModalities: z.array(Modality).optional(),
  reasoning: z.boolean().optional(),
  toolcall: z.boolean().optional(),
  temperature: z.boolean().optional(),
  status: z.enum(["active", "deprecated", "alpha", "beta"]).optional(),
  releaseDate: z.string().optional(),
  cost: Price.extend({
    currency: z.enum(["USD", "CNY"]),
    tiers: z.array(Price.extend({ above: z.number(), thinking: Price.optional() })).optional(),
    thinking: Price.optional(),
  }).optional(),
  efforts: z.array(z.string()).optional(),
  canDisable: z.boolean().optional(),
  defaultEffort: z.string().optional(),
})
export type CatalogModel = z.infer<typeof CatalogModel>

export const CatalogFile = z.object({
  fetchedAt: z.number(),
  models: z.array(CatalogModel),
})
export type CatalogFile = z.infer<typeof CatalogFile>

/** Parses one adapter result. A bad record is dropped by the caller. */
export function accept(value: unknown): CatalogModel | undefined {
  const parsed = CatalogModel.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function parseItems(items: readonly unknown[], parse: (item: unknown) => CatalogModel | undefined) {
  return items.flatMap((item) => {
    const model = parse(item)
    return model ? [model] : []
  })
}

/** Lists use 0 and null as "not stated". */
export function positive(value: unknown) {
  return typeof value === "number" && value > 0 ? value : undefined
}

const MODALITY: Record<string, Modality> = {
  text: "text",
  audio: "audio",
  image: "image",
  video: "video",
  pdf: "pdf",
  file: "pdf",
}

export function modalities(values: readonly string[] | undefined) {
  if (!values) return undefined
  const mapped = values.flatMap((value) => {
    const modality = MODALITY[value.toLowerCase()]
    return modality ? [modality] : []
  })
  return mapped.length ? [...new Set(mapped)] : undefined
}
