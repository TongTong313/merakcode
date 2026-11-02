import z from "zod"
import { encodeDir } from "../../lib/route"
import { persistent } from "../../lib/persistence"

const schema = z.object({
  version: z.literal(1),
  content: z.string(),
  saved: z.string(),
  checksum: z.string().optional(),
})
const bucket = (directory: string) => `draft-${encodeDir(directory)}`
const writes = new Map<string, Promise<void>>()
type Draft = Omit<z.infer<typeof schema>, "version">
const retained = new Map<string, { directory: string; path: string; value?: Draft }>()

export async function readDraft(directory: string, path: string) {
  const latest = retained.get(`${directory}\0${path}`)
  if (latest) return latest.value && { version: 1 as const, ...latest.value }
  const raw = await persistent.get(bucket(directory), path)
  if (!raw) return
  try {
    return schema.parse(JSON.parse(raw))
  } catch {
    return
  }
}

export function writeDraft(directory: string, path: string, value?: Draft) {
  const key = `${directory}\0${path}`
  retained.set(key, { directory, path, value })
  const known = writes.get(key)
  if (known) return known
  const request = Promise.resolve().then(async () => {
    try {
      for (;;) {
        const latest = retained.get(key)
        if (!latest) return
        if (latest.value) await persistent.set(bucket(directory), path, JSON.stringify({ version: 1, ...latest.value }))
        else await persistent.remove(bucket(directory), path)
        if (retained.get(key) !== latest) continue
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
