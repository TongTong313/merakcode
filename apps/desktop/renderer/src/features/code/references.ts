import z from "zod"
import { t } from "../../i18n"
import { persistent } from "../../lib/persistence"
import { encodeDir } from "../../lib/route"
import { fileAddress, fileDirectories, storedFileAddress, type RecoveryMode } from "./identity"

async function read(directory: string, path: string, mode: RecoveryMode = "resolve") {
  const entries = (
    await Promise.all(
      (await fileDirectories("file-links-", directory, mode)).map(async (directory) =>
        (await persistent.entries(bucket(directory))).map(async ([key, raw]) =>
          (await storedFileAddress(directory, key, undefined, mode)).path === path
            ? { directory, path: key, raw }
            : undefined,
        ),
      ),
    )
  ).flat()
  const matching = (await Promise.all(entries)).filter((value) => value !== undefined)
  const owners = matching.flatMap(({ raw }) => {
    try {
      return z.array(z.string()).parse(JSON.parse(raw))
    } catch {
      return []
    }
  })
  return { entries: matching, owners: [...new Set(owners)] }
}

const pending = new Map<string, Promise<unknown>>()
const bucket = (directory: string) => `file-links-${encodeDir(directory)}`

/** References describe open tabs, including sleeping conversations; mounted views are a separate lifetime. */
async function change(directory: string, path: string, update: (owners: string[]) => string[], mode?: RecoveryMode) {
  const address = fileAddress(directory, path)
  directory = address.directory
  path = address.path
  const key = `${directory}\0${path}`
  if (mode === "cached" && pending.has(key)) return Promise.reject(new Error(t("panel.persistError")))
  const request = (pending.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const previous = await read(directory, path, mode)
      const owners = [...new Set(update(previous.owners))]
      if (owners.length) await persistent.set(bucket(directory), path, JSON.stringify(owners))
      else await persistent.remove(bucket(directory), path)
      for (const entry of previous.entries)
        if (entry.path !== path || entry.directory !== directory)
          await persistent.remove(bucket(entry.directory), entry.path)
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
export const releaseFile = (directory: string, path: string, owner: string, mode?: RecoveryMode) =>
  change(directory, path, (owners) => owners.filter((value) => value !== owner), mode)
export async function fileOwners(directory: string, path: string) {
  const address = fileAddress(directory, path)
  await pending.get(`${address.directory}\0${address.path}`)
  return (await read(address.directory, address.path)).owners
}
