import fs from "fs/promises"
import { constants, existsSync } from "fs"
import path from "path"
import { setTimeout as sleep } from "timers/promises"
import { Filesystem } from "@merakcode/util/filesystem"
import { Paths } from "@merakcode/util/paths"

/**
 * On engine startup: creates the data directories and clears the cache when its version changes. The paths
 * themselves live in @merakcode/util/paths.
 */
export namespace Global {
  export const Path = Paths
}

async function mkdirp(dir: string) {
  const existing = await fs.stat(dir).catch(() => undefined)
  if (existing?.isDirectory()) return

  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return

    const stat = await fs.stat(dir).catch(() => undefined)
    if (stat?.isDirectory()) return
    throw error
  }
}

const CACHE_VERSION = "21"
/**
 * Held by the engine clearing the cache. Engines started together (the desktop app and the command line) would
 * otherwise each clear it and remove what another had just created; the others wait and then read the new version.
 */
const RESET_LOCK = ".reset"
/** A lock this old was left by an engine that died while clearing */
const RESET_STALE_MS = 30_000

const cacheVersion = () => Filesystem.readText(path.join(Global.Path.cache, "version")).catch(() => "0")

while ((await cacheVersion()) !== CACHE_VERSION) {
  await mkdirp(Global.Path.cache)
  const lock = path.join(Global.Path.cache, RESET_LOCK)
  const held = await fs.mkdir(lock).then(
    () => true,
    () => false,
  )
  if (!held) {
    const since = await fs.stat(lock).then(
      (stat) => stat.mtimeMs,
      () => undefined,
    )
    if (since !== undefined && Date.now() - since > RESET_STALE_MS) await fs.rm(lock, { recursive: true, force: true })
    await sleep(20)
    continue
  }
  try {
    if ((await cacheVersion()) === CACHE_VERSION) break
    const contents = await fs.readdir(Global.Path.cache).catch(() => [])
    await Promise.all(
      contents
        .filter((item) => item !== RESET_LOCK)
        .map((item) => fs.rm(path.join(Global.Path.cache, item), { recursive: true, force: true }).catch(() => {})),
    )
    await Filesystem.write(path.join(Global.Path.cache, "version"), CACHE_VERSION)
  } finally {
    await fs.rm(lock, { recursive: true, force: true })
  }
}

const fresh = !existsSync(Global.Path.data)

for (const dir of [Global.Path.data, Global.Path.config, Global.Path.bin]) {
  await mkdirp(dir)
}

// Earlier versions kept config and data in separate XDG directories: a new default root takes over the global config
// and the saved credentials once. A root moved by MERAKCODE_HOME (tests set one) starts empty, and nothing that
// already exists is overwritten
if (fresh && !process.env.MERAKCODE_HOME) {
  const config = path.join(Global.Path.home, ".config", "merakcode")
  const data = path.join(Global.Path.home, ".local", "share", "merakcode")
  const files = [
    ...["merakcode.jsonc", "merakcode.json", "AGENTS.md"].map((name) => [path.join(config, name), Global.Path.config]),
    [path.join(data, "auth.json"), Global.Path.data],
  ] as const
  for (const [file, dir] of files)
    if (existsSync(file))
      await fs.copyFile(file, path.join(dir, path.basename(file)), constants.COPYFILE_EXCL).catch(() => {})
}
