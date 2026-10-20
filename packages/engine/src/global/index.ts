import fs from "fs/promises"
import path from "path"
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

for (const dir of [Global.Path.data, Global.Path.config, Global.Path.state, Global.Path.bin]) {
  await mkdirp(dir)
}

const CACHE_VERSION = "21"

const version = await Filesystem.readText(path.join(Global.Path.cache, "version")).catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Global.Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Global.Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch (e) {}
  await Filesystem.write(path.join(Global.Path.cache, "version"), CACHE_VERSION)
}
