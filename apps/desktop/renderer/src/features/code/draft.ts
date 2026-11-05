import z from "zod"
import { encodeDir } from "../../lib/route"
import { persistent } from "../../lib/persistence"
import { gitDirectory, registerDirty } from "../../state/git"
import { fileAddress, fileDirectories } from "./identity"

const draftSchema = z.object({
  content: z.string(),
  saved: z.string(),
  checksum: z.string().optional(),
  identity: z
    .object({ directory: z.string(), branch: z.string().nullable(), head: z.string().nullable() })
    .nullable()
    .optional(),
  planSessionID: z.string().optional(),
  planRootSessionID: z.string().optional(),
})
const schema = draftSchema.extend({ version: z.literal(1), alternatives: z.array(draftSchema).optional() })
const bucket = (directory: string) => `draft-${encodeDir(directory)}`
const writes = new Map<string, Promise<void>>()
export type Draft = Omit<z.infer<typeof schema>, "version">
const retained = new Map<string, { directory: string; path: string; value?: Draft }>()
const protectedPaths = new Map<string, Set<string>>()

/** Recover sleeping conversations before branch controls become available. */
export async function restoreDraftProtection(directory: string) {
  directory = gitDirectory(directory)
  const entries = new Map<string, string>()
  for (const alias of await fileDirectories("draft-", directory))
    for (const [path, raw] of await persistent.entries(bucket(alias))) entries.set(fileAddress(alias, path).path, raw)
  for (const item of retained.values()) {
    if (item.directory !== directory) continue
    if (item.value) entries.set(item.path, "pending")
    else entries.delete(item.path)
  }
  const paths = new Set(entries.keys())
  for (const path of new Set([...(protectedPaths.get(directory) ?? []), ...paths]))
    registerDirty(directory, `editor:draft:${directory}:${path}`, paths.has(path) ? 1 : 0)
  protectedPaths.set(directory, paths)
}

export async function readDraft(directory: string, path: string) {
  const address = fileAddress(directory, path)
  path = address.path
  const latest = retained.get(`${address.directory}\0${path}`)
  if (latest) return latest.value && { version: 1 as const, ...latest.value }
  const entries = await aliases(directory, path)
  const values = entries.flatMap((entry) => {
    try {
      return [{ ...entry, value: schema.parse(JSON.parse(entry.raw)) }]
    } catch {
      return []
    }
  })
  const primary =
    values.find((entry) => entry.directory === gitDirectory(directory) && entry.path === path) ?? values[0]
  if (!primary) return
  const alternatives: z.infer<typeof draftSchema>[] = []
  const signature = (value: z.infer<typeof draftSchema>) => JSON.stringify(draftSchema.parse(value))
  const seen = new Set([signature(primary.value)])
  for (const entry of values)
    for (const value of [entry.value, ...(entry.value.alternatives ?? [])]) {
      const key = signature(value)
      if (seen.has(key)) continue
      seen.add(key)
      alternatives.push(draftSchema.parse(value))
    }
  const value = { ...primary.value, ...(alternatives.length ? { alternatives } : {}) }
  if (entries.length > 1 || primary.path !== path || primary.directory !== gitDirectory(directory))
    await writeDraft(directory, path, value)
  return value
}

export async function planDrafts(directory: string) {
  await flushDrafts()
  const entries = (
    await Promise.all(
      (await fileDirectories("draft-", directory)).map((directory) => persistent.entries(bucket(directory))),
    )
  ).flat()
  return entries.flatMap(([path, raw]) => {
    try {
      const value = schema.parse(JSON.parse(raw))
      return value.planSessionID
        ? [
            {
              path: fileAddress(directory, path, value.planSessionID).path,
              sessionID: value.planSessionID,
              root: value.planRootSessionID,
            },
          ]
        : []
    } catch {
      return []
    }
  })
}

async function aliases(directory: string, path: string) {
  const lists = await Promise.all(
    (await fileDirectories("draft-", directory)).map(async (directory) =>
      (await persistent.entries(bucket(directory)))
        .filter(([key, raw]) => {
          let planSessionID: string | undefined
          try {
            planSessionID = schema.parse(JSON.parse(raw)).planSessionID
          } catch {}
          return fileAddress(directory, key, planSessionID).path === path
        })
        .map(([path, raw]) => ({ directory, path, raw })),
    ),
  )
  return lists.flat()
}

export function writeDraft(directory: string, path: string, value?: Draft) {
  const source = directory
  const address = fileAddress(directory, path, value?.planSessionID)
  directory = address.directory
  path = address.path
  const key = `${directory}\0${path}`
  retained.set(key, { directory, path, value })
  if (value) registerDirty(directory, `editor:draft:${directory}:${path}`, 1)
  const known = writes.get(key)
  if (known) return known
  const request = Promise.resolve().then(async () => {
    try {
      for (;;) {
        const latest = retained.get(key)
        if (!latest) return
        if (latest.value) await persistent.set(bucket(directory), path, JSON.stringify({ version: 1, ...latest.value }))
        else await persistent.remove(bucket(directory), path)
        for (const entry of await aliases(source, path)) {
          if (entry.directory === directory && entry.path === path) continue
          await persistent.remove(bucket(entry.directory), entry.path)
          registerDirty(entry.directory, `editor:draft:${entry.directory}:${entry.path}`, 0)
        }
        if (retained.get(key) !== latest) continue
        registerDirty(directory, `editor:draft:${directory}:${path}`, latest.value ? 1 : 0)
        retained.delete(key)
        if (writes.get(key) === request) writes.delete(key)
        return
      }
    } catch (error) {
      if (writes.get(key) === request) writes.delete(key)
      throw error
    }
  })
  writes.set(key, request)
  void request.catch(() => {})
  return request
}

export async function flushDrafts() {
  while (retained.size) {
    await Promise.all(
      [...retained].map(async ([key, latest]) => {
        try {
          await (writes.get(key) ?? writeDraft(latest.directory, latest.path, latest.value))
        } catch {
          const current = retained.get(key)
          if (current) await writeDraft(current.directory, current.path, current.value)
        }
      }),
    )
  }
}
