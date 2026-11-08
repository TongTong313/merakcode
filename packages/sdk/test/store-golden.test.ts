import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { z } from "zod"
import { SqliteStore } from "../src/store"
import { EventEventSchema, StoreDocSchema } from "../src/protocol.gen"

test("reads Go and TypeScript golden databases without data loss", async (t) => {
  const root = new URL("../../../schema/testdata/", import.meta.url)
  const fixture = z
    .object({ events: z.array(EventEventSchema), docs: z.array(StoreDocSchema) })
    .parse(JSON.parse(await readFile(new URL("store.json", root), "utf8")))
  if (process.env.MERAK_GENERATE_STORE_GOLDEN === "1") {
    const store = new SqliteStore(fileURLToPath(new URL("typescript.db", root)))
    try {
      store.append(fixture.events)
      for (const doc of fixture.docs) store.put({ ...doc, rev: 0 })
    } finally {
      store.close()
    }
    return
  }
  const dir = await mkdtemp(path.join(tmpdir(), "merak-golden-"))
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }))
  for (const name of ["go.db", "typescript.db"]) {
    const target = path.join(dir, name)
    await copyFile(new URL(name, root), target)
    const store = new SqliteStore(target)
    try {
      expect(store.read("session:golden", 1, 100)).toEqual(fixture.events)
      for (const doc of fixture.docs) expect(store.fetch(doc.kind, doc.key)).toEqual(doc)
    } finally {
      store.close()
    }
  }
})
