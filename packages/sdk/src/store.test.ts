import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { SqliteStore } from "./store"
import type { EventEvent, StoreQuery } from "./protocol.gen"

const fact = (id: string, stream: string, seq: number): EventEvent => ({
  id,
  stream,
  seq,
  time: `2026-11-08T01:00:0${seq}Z`,
  type: "message.sent",
  scope: { session: "a" },
  actor: { kind: "human" },
  payload: { role: "user", parts: [{ text: "hello" }] },
})

describe("SQLite storage contract", () => {
  test("stores versioned documents and binary blobs without shared memory", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "merak-store-"))
    const store = new SqliteStore(path.join(dir, "merak.db"))
    t.onTestFinished(async () => {
      store.close()
      await rm(dir, { recursive: true, force: true })
    })
    const doc = { kind: "blob", key: "artifact/a", rev: 0, body: "AP8B", meta: { title: "binary" } }
    store.put(doc)
    doc.body = "Cf8B"
    doc.meta.title = "changed"
    const saved = store.fetch("blob", "artifact/a")
    expect(saved).toEqual({ kind: "blob", key: "artifact/a", rev: 1, body: "AP8B", meta: { title: "binary" } })
    expect(() => store.put(doc)).toThrow("conflict")
    store.put({ ...saved, body: Buffer.from("updated").toString("base64") })
    store.put({ kind: "blob", key: "other", rev: 0, body: null })
    store.put({ kind: "snapshot", key: "artifact/a", rev: 0, body: null })
    expect(store.list("blob", "artifact/")).toEqual([
      { kind: "blob", key: "artifact/a", rev: 2, meta: { title: "binary" } },
    ])
    expect(() => store.fetch("blob", "missing")).toThrow("not-found")
  })
  test("finds events by every scope field and retrieves an ID", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "merak-store-"))
    const store = new SqliteStore(path.join(dir, "merak.db"))
    t.onTestFinished(async () => {
      store.close()
      await rm(dir, { recursive: true, force: true })
    })
    const first = { ...fact("one", "session:a", 1), scope: { group: "g", task: "t", session: "a", turn: "turn" } }
    const second = { ...fact("two", "session:a", 2), scope: { group: "g", session: "a" } }
    const third = {
      ...fact("three", "session:b", 1),
      scope: { session: "b" },
      type: "task.reported",
      time: "2026-11-08T00:00:01Z",
    }
    store.append([first, second, third])
    const cases: [StoreQuery, EventEvent[]][] = [
      [{ scope: { group: "g" } }, [first, second]],
      [{ scope: { task: "t" } }, [first]],
      [{ scope: { session: "b" } }, [third]],
      [{ scope: { turn: "turn" } }, [first]],
      [{ scope: { group: "g", session: "b" } }, []],
      [{ types: ["task.reported"] }, [third]],
      [{ after: third.time, before: second.time }, [first]],
      [{ limit: 1 }, [third]],
    ]
    for (const [query, want] of cases) expect(store.find(query)).toEqual(want)
    expect(store.get("one")).toEqual(first)
    expect(() => store.get("missing")).toThrow("not-found")
  })
  test("appends consecutive events atomically and reads in sequence order", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "merak-store-"))
    const store = new SqliteStore(path.join(dir, "merak.db"))
    t.onTestFinished(async () => {
      store.close()
      await rm(dir, { recursive: true, force: true })
    })
    const first = fact("one", "session:a", 1)
    const second = fact("two", "session:a", 2)
    store.append([first])
    for (const batch of [
      [fact("gap", "session:a", 3)],
      [fact("repeat", "session:a", 1)],
      [second, fact("later-gap", "session:a", 4)],
      [fact("one", "session:b", 1)],
    ])
      expect(() => store.append(batch)).toThrow("sequence")
    store.append([second])
    expect(store.read("session:a", 1, 10)).toEqual([first, second])
    expect(store.read("session:a", 2, 1)).toEqual([second])
  })
})
