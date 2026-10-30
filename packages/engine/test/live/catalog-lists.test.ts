/**
 * Live contract: each official model list, fetched with a real key, parses with the shipped adapter. Not part of the
 * regular suite. Run it explicitly with the keys of the providers to check, for example:
 *   DASHSCOPE_API_KEY=... DEEPSEEK_API_KEY=... pnpm test:live test/live/catalog-lists.test.ts
 * A provider without a key in the environment is reported as skipped.
 */
import { expect, test } from "vitest"
import * as Catalog from "../../src/agent/model/catalog"
import { CatalogModel } from "../../src/agent/model/catalog/model"
import { OFFICIAL } from "../../src/agent/model/official"

for (const spec of Object.values(OFFICIAL)) {
  const key = spec.env.map((name) => process.env[name]).find(Boolean)
  test.skipIf(!key)(`the live ${spec.name} list parses with the shipped adapter`, async () => {
    expect((await Catalog.refresh(spec.id, { key: key!, baseURL: spec.api })).ok).toBe(true)
    const models = await Catalog.read(spec.id)
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) expect(CatalogModel.safeParse(model).success, model.id).toBe(true)
  })
}

test("the live public catalog parses with the OpenRouter adapter", async () => {
  expect((await Catalog.refreshPublic()).ok).toBe(true)
  expect((await Catalog.readPublic()).length).toBeGreaterThan(100)
})
