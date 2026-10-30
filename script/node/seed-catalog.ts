import fs from "node:fs/promises"
import path from "node:path"

const SEED = path.resolve(import.meta.dirname, "../../packages/engine/test/provider/catalog/seed")
/** Must match CACHE_VERSION in packages/engine/src/infra/global/index.ts, or the engine clears the cache on start. */
const CACHE_VERSION = "21"

/** Writes the model catalog cache a test engine reads instead of calling providers. Shared by every test setup. */
export async function seedCatalog(home: string) {
  const dest = path.join(home, "cache", "catalog")
  await fs.mkdir(dest, { recursive: true })
  await fs.writeFile(path.join(home, "cache", "version"), CACHE_VERSION)
  for (const name of await fs.readdir(SEED)) {
    if (name.endsWith(".json")) await fs.copyFile(path.join(SEED, name), path.join(dest, name))
  }
}
