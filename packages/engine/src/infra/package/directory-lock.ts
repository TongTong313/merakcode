import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { taggedProcesses } from "../process/tree"

type Owner = { pid: number; child: number; choosing: boolean; ticket: number }

/** Bakery ordering gives each contender its own record; crashed waiters cannot strand a shared reaper lock. */
export async function withDependencyLock<T>(
  dir: string,
  task: (track: (pid: number) => Promise<void>) => Promise<T>,
): Promise<T> {
  const root = path.join(dir, ".merakcode-dependencies.lock")
  await fs.mkdir(root, { recursive: true })
  const name = process.pid + "-" + randomUUID() + ".json"
  const file = path.join(root, name)
  const owner: Owner = { pid: process.pid, child: 0, choosing: true, ticket: 0 }
  const save = async () => {
    await fs.writeFile(file + ".next", JSON.stringify(owner))
    await fs.rename(file + ".next", file)
  }
  try {
    await save()
    owner.ticket = 1 + Math.max(0, ...(await records(root)).map((entry) => entry.owner.ticket))
    owner.choosing = false
    await save()
    const deadline = Date.now() + 40_000
    while (
      (await records(root)).some(
        (entry) =>
          entry.name !== name &&
          (entry.owner.choosing ||
            entry.owner.ticket < owner.ticket ||
            (entry.owner.ticket === owner.ticket && entry.name < name)),
      )
    ) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the dependency installation lock")
      await sleep(25)
    }
    return await task(async (pid) => {
      owner.child = pid
      await save()
    })
  } finally {
    await fs.rm(file, { force: true, maxRetries: 5 })
    await fs.rm(file + ".next", { force: true, maxRetries: 5 })
  }
}

function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function records(root: string) {
  const entries: { name: string; owner: Owner }[] = []
  for (const name of await fs.readdir(root)) {
    const match = /^(\d+)-[\da-f-]+\.json$/.exec(name)
    if (!match) continue
    const file = path.join(root, name)
    const fallback: Owner = { pid: Number(match[1]), child: 0, choosing: true, ticket: 0 }
    let owner: Owner = await fs.readFile(file, "utf8").then(
      (text) => {
        try {
          return JSON.parse(text) as Owner
        } catch {
          return fallback
        }
      },
      () => fallback,
    )
    if (!alive(owner.pid)) {
      // The parent may have registered npm after our first read. Once it has exited its final record is stable.
      const final = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (final === undefined) continue
      owner = JSON.parse(final) as Owner
      if (!(
        owner.child > 0 &&
        (alive(owner.child) ||
          (await taggedProcesses({ name: "MERAKCODE_DEPENDENCY_RUN", value: String(owner.child) })).length)
      )) {
        await fs.rm(file, { force: true, maxRetries: 5 })
        continue
      }
    }
    entries.push({ name, owner })
  }
  return entries
}
