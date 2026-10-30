import fs from "fs/promises"
import path from "path"
import { Global } from "@merakcode/engine/infra/global/index"
import { Filesystem } from "@merakcode/util/filesystem"
import type { CatalogModel } from "../../../src/agent/model/catalog/model"
import { seedCatalog } from "../../../../../script/node/seed-catalog.ts"

/** A saved provider response under fixtures/. */
export function load(name: string): Promise<any> {
  return Filesystem.readJson(new URL(`./fixtures/${name}.json`, import.meta.url))
}

export function parseItems(items: unknown[], parse: (item: unknown) => CatalogModel | undefined) {
  return items.flatMap((item) => {
    const model = parse(item)
    return model ? [model] : []
  })
}

/** Replaces one cached list in this test process. Call restoreCatalog afterwards. */
export async function writeCatalog(name: string, models: Array<Partial<CatalogModel> & { id: string }>) {
  const rows = models.map((model) => ({ name: model.id, ...model }))
  await Filesystem.write(
    path.join(Global.Path.cache, "catalog", `${name}.json`),
    JSON.stringify({ fetchedAt: Date.now(), models: rows }),
  )
}

/** Puts the shared seed back and drops any public catalog a test wrote. */
export async function restoreCatalog() {
  await fs.rm(path.join(Global.Path.cache, "catalog", "public.json"), { force: true })
  await seedCatalog(path.dirname(Global.Path.cache))
}
