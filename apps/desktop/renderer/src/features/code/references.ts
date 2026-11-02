import z from "zod"
import { persistent } from "../../lib/persistence"
import { encodeDir } from "../../lib/route"

const pending = new Map<string, Promise<unknown>>()
const bucket = (directory: string) => `file-links-${encodeDir(directory)}`

/** References describe open tabs, including sleeping conversations; mounted views are a separate lifetime. */
async function change(directory: string, path: string, update: (owners: string[]) => string[]) {
  const key = `${directory}\0${path}`
  const request = (pending.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const raw = await persistent.get(bucket(directory), path)
      const parsed = (() => {
        try {
          return z.array(z.string()).parse(JSON.parse(raw ?? "[]"))
        } catch {
          return []
        }
      })()
      const owners = [...new Set(update(parsed))]
      if (owners.length) await persistent.set(bucket(directory), path, JSON.stringify(owners))
      else await persistent.remove(bucket(directory), path)
      return owners
    })
  pending.set(key, request)
  void request
    .finally(() => {
      if (pending.get(key) === request) pending.delete(key)
    })
    .catch(() => {})
  return request
}

export const retainFile = (directory: string, path: string, owner: string) =>
  change(directory, path, (owners) => [...owners, owner])
export const releaseFile = (directory: string, path: string, owner: string) =>
  change(directory, path, (owners) => owners.filter((value) => value !== owner))
export const fileOwners = (directory: string, path: string) => change(directory, path, (owners) => owners)
