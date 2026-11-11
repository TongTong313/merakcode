import z from "zod"
import { t } from "../../i18n"
import { encodeDir } from "../../lib/route"
import { persistent } from "../../lib/persistence"
import { gitDirectory, registerDirty } from "../../state/git"
import { fileAddress, fileDirectories, storedFileAddress, type RecoveryMode } from "./identity"

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
const revisions = new Map<string, number>()
export type Draft = Omit<z.infer<typeof schema>, "version">
const retained = new Map<string, { directory: string; path: string; value?: Draft }>()
const protectedPaths = new Map<string, Set<string>>()

/** Recover sleeping conversations before branch controls become available. */
export async function restoreDraftProtection(directory: string) {
  directory = gitDirectory(directory)
  const stamp = new Map(revisions)
  const entries = new Map<string, string>()
  for (const alias of await fileDirectories("draft-", directory))
    for (const [path, raw] of await persistent.entries(bucket(alias))) entries.set(fileAddress(alias, path).path, raw)
  for (const item of retained.values()) {
    if (item.directory !== directory) continue
    if (item.value) entries.set(item.path, "pending")
    else entries.delete(item.path)
  }
  const paths = new Set(entries.keys())
  for (const path of new Set([...(protectedPaths.get(directory) ?? []), ...paths])) {
    const key = `${directory}\0${path}`
    // A discard or save started during the storage read owns the flag.
    if ((revisions.get(key) ?? 0) !== (stamp.get(key) ?? 0)) continue
    const pending = retained.get(key)
    const present = pending ? !!pending.value : paths.has(path)
    registerDirty(directory, `editor:draft:${directory}:${path}`, present ? 1 : 0)
  }
  protectedPaths.set(directory, paths)
}

export async function readDraft(
  directory: string,
  path: string,
  options: { migrate?: boolean } = {},
): Promise<(Draft & { version: 1 }) | undefined> {
  const address = fileAddress(directory, path)
  path = address.path
  const key = `${address.directory}\0${path}`
  const revision = revisions.get(key)
  const latest = retained.get(key)
  if (latest) return latest.value && { version: 1 as const, ...latest.value }
  const entries = await aliases(directory, path)
  // A completed user write is no longer retained, but still supersedes this storage snapshot.
  if (revisions.get(key) !== revision) return readDraft(directory, path, options)
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
  if (
    options.migrate !== false &&
    (entries.length > 1 || primary.path !== path || primary.directory !== gitDirectory(directory))
  ) {
    await writeDraft(directory, path, value)
    return readDraft(directory, path, { migrate: false })
  }
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

async function aliases(directory: string, path: string, mode: RecoveryMode = "resolve") {
  const lists = await Promise.all(
    (await fileDirectories("draft-", directory, mode)).map(async (directory) =>
      (await persistent.entries(bucket(directory))).map(async ([key, raw]) => {
        let planSessionID: string | undefined
        try {
          planSessionID = schema.parse(JSON.parse(raw)).planSessionID
        } catch {}
        return (await storedFileAddress(directory, key, planSessionID, mode)).path === path
          ? { directory, path: key, raw }
          : undefined
      }),
    ),
  )
  return (await Promise.all(lists.flat())).filter((value) => value !== undefined)
}

export function writeDraft(directory: string, path: string, value?: Draft, mode?: RecoveryMode) {
  const source = directory
  const address = fileAddress(directory, path, value?.planSessionID)
  directory = address.directory
  path = address.path
  const key = `${directory}\0${path}`
  if (mode === "cached" && (writes.has(key) || retained.has(key)))
    return Promise.reject(new Error(t("panel.persistError")))
  revisions.set(key, (revisions.get(key) ?? 0) + 1)
  const change = { directory, path, value }
  retained.set(key, change)
  registerDirty(directory, `editor:draft:${directory}:${path}`, value ? 1 : 0)
  const known = writes.get(key)
  if (known) return known
  const request = Promise.resolve().then(async () => {
    try {
      for (;;) {
        const latest = retained.get(key)
        if (!latest) return
        const entries = mode === "cached" ? await aliases(source, path, mode) : undefined
        if (latest.value) await persistent.set(bucket(directory), path, JSON.stringify({ version: 1, ...latest.value }))
        else await persistent.remove(bucket(directory), path)
        let copies: Awaited<ReturnType<typeof aliases>>
        try {
          copies = entries ?? (await aliases(source, path))
        } catch (error) {
          if (retained.get(key) !== latest) continue
          // The bytes are stored. A missing directory must not block closing while other spellings are cleaned up.
          if (!latest.value) throw error
          registerDirty(directory, `editor:draft:${directory}:${path}`, 1)
          retained.delete(key)
          if (writes.get(key) === request) writes.delete(key)
          return
        }
        for (const entry of copies) {
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
      // The transfer journal retries cancellation; only user edits belong in the ordinary shutdown queue.
      if (mode === "cached" && retained.get(key) === change) retained.delete(key)
      if (writes.get(key) === request) writes.delete(key)
      throw error
    }
  })
  writes.set(key, request)
  void request.catch(() => {})
  return request
}

export async function flushDrafts() {
  const deadline = Date.now() + 20_000
  while (retained.size) {
    if (Date.now() >= deadline) return
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
