import { mkdir, rmdir } from "node:fs/promises"
import path from "node:path"
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest"
import type { BrowserState } from "../../desktop/bridge-contract"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { persistent } from "../../lib/persistence"
import { encodeDir } from "../../lib/route"
import { flushPanels, openPanel, promotePanels, selectPanels } from "./workspace"
import { releaseBrowserState } from "../browser/state"

const events = vi.hoisted(() => ({ state: (_state: BrowserState) => {} }))
// Electron is absent in tests: its preload bridge is replaced by storage in localStorage and a browser event hook.
vi.mock("../../lib/bridge", () => ({
  log: () => {},
  storage: {},
  mac: false,
  bridge: {
    onBrowserState: (handler: (state: BrowserState) => void) => {
      events.state = handler
    },
    onBrowserConsole: () => {},
    storageGet: async (bucket: string, key: string) => localStorage.getItem(`${bucket}:${key}`),
    storageBuckets: async () => [...new Set(Object.keys(localStorage).map((key) => key.split(":")[0]!))],
    storageEntries: async (bucket: string) =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith(`${bucket}:`))
        .map((key) => [key.slice(bucket.length + 1), localStorage.getItem(key)!]),
    storageSet: async (bucket: string, key: string, value: string) => localStorage.setItem(`${bucket}:${key}`, value),
    storageRemove: async (bucket: string, key: string) => localStorage.removeItem(`${bucket}:${key}`),
  },
}))

let env: Awaited<ReturnType<typeof engineFixture>>
let engine: Awaited<ReturnType<typeof client>>
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
  engine = await client()
}, 120_000)
afterAll(async () => {
  try {
    await engine.close()
  } finally {
    await env?.close()
  }
})
beforeEach(() => {
  localStorage.clear()
})

/** A conversation the engine really knows, so a recovered promotion is not taken for a deleted chat. */
const chat = async () =>
  (await engine.session.create({ provider: "fake", model: "test", workdir: env.project })).session
const state = (id: string, url: string, title: string): BrowserState => ({
  id,
  url,
  title,
  loading: false,
  canGoBack: true,
  canGoForward: false,
})

test.each([
  [false, false],
  [true, false],
  [true, true],
])(
  "background navigation survives controller eviction and an offline file directory (storage failure: %s, during flush: %s)",
  async (fail, duringFlush) => {
    // A real folder that is removed afterwards stands for a volume that went offline.
    const directory = path.join(path.dirname(env.project), `evicted-browser-offline-file-${fail}-${duringFlush}`)
    await mkdir(directory)
    const sessionID = await chat()
    const owner = await selectPanels({ directory, sessionID })
    await openPanel({ kind: "file", path: "notes.txt" })
    await openPanel({ kind: "browser", url: "https://example.invalid/old" })
    const id = owner.state.tabs.find((tab) => tab.kind === "browser")!.id
    const file = JSON.parse(JSON.stringify(owner.state.tabs[0]))
    for (let index = 0; index < 33; index++) await selectPanels({ directory, sessionID: await chat() })
    await rmdir(directory)
    const set = persistent.set
    let attempts = 0
    const storage = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
      if (args[0] === `panels-${encodeDir(sessionID)}` && args[2].includes("/final") && ++attempts === 1 && fail)
        throw new Error("storage unavailable")
      return set(...args)
    })
    try {
      const flushing = duringFlush ? flushPanels() : undefined
      events.state(state(id, "https://example.invalid/final", "Final page"))
      await (flushing ?? flushPanels())
      const stored = JSON.parse((await persistent.get(`panels-${encodeDir(sessionID)}`, "layout"))!)
      expect(stored.tabs).toContainEqual(file)
      expect(stored.tabs.find((tab: { id: string }) => tab.id === id)).toMatchObject({
        url: "https://example.invalid/final",
        title: "Final page",
      })
    } finally {
      storage.mockRestore()
      await releaseBrowserState(id)
    }
  },
)

test.each(["null", "[]", "{broken", '{"directory":42}', '{"directory":"/invalid","sessionID":42}'])(
  "invalid persisted browser ownership does not block shutdown (%s)",
  async (raw) => {
    const id = crypto.randomUUID()
    await persistent.set("browser-owners", id, raw)
    try {
      events.state(state(id, "https://example.invalid/final", "Final"))
      await flushPanels()
      expect(await persistent.get("browser-owners", id)).toBe(raw)
    } finally {
      await releaseBrowserState(id)
    }
  },
)

test("failed browser owner registration is retried before a layout flush completes", async () => {
  const owner = await selectPanels({ directory: "/browser-owner-retry", sessionID: await chat() })
  const original = persistent.set
  let attempts = 0
  const failing = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
    if (args[0] === "browser-owners" && ++attempts === 1) throw new Error("storage unavailable")
    return original(...args)
  })
  try {
    await expect(openPanel({ kind: "browser", url: "https://example.invalid/old" })).rejects.toThrow()
    await flushPanels()
    expect(await persistent.get("browser-owners", owner.state.tabs[0]!.id)).not.toBeNull()
    expect(attempts).toBe(2)
  } finally {
    failing.mockRestore()
  }
})

test("navigation received during promotion reaches the destination and closed tabs ignore late events", async () => {
  const directory = "/browser-promotion"
  const source = await selectPanels({ directory })
  await openPanel({ kind: "browser", url: "https://example.invalid/old" })
  const id = source.state.tabs[0]!.id
  const target = { directory, sessionID: await chat() }
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const finalWrite = Promise.withResolvers<void>()
  const finishWrite = Promise.withResolvers<void>()
  const original = persistent.set
  const delayed = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
    if (args[0] === `panels-${encodeDir(target.sessionID)}`) {
      entered.resolve()
      await gate.promise
      if (args[2].includes("/final")) {
        finalWrite.resolve()
        await finishWrite.promise
      }
    }
    return original(...args)
  })
  try {
    const promotion = promotePanels(directory, target)
    await entered.promise
    let flushed = false
    const flushing = flushPanels().then(() => {
      flushed = true
    })
    events.state(state(id, "https://example.invalid/final", "Final"))
    gate.resolve()
    await finalWrite.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(flushed).toBe(false)
    finishWrite.resolve()
    await promotion
    await flushing
    await flushPanels()
    const destination = await selectPanels(target)
    expect(destination.state.tabs[0]!.url).toBe("https://example.invalid/final")
    await releaseBrowserState(id)
    await destination.remove(id)
    events.state(state(id, "https://example.invalid/late", "Late"))
    await flushPanels()
    expect(destination.state.tabs).toHaveLength(0)
    expect(JSON.parse((await persistent.get(`panels-${encodeDir(target.sessionID)}`, "layout"))!).tabs).toEqual([])
  } finally {
    gate.resolve()
    finishWrite.resolve()
    delayed.mockRestore()
  }
})

test("an address-shaped title does not replace the document title already stored for that page", async () => {
  const directory = "/browser-title"
  const source = await selectPanels({ directory })
  await openPanel({ kind: "browser", url: "http://127.0.0.1:1/old" })
  const id = source.state.tabs[0]!.id
  const send = (title: string) => events.state({ ...state(id, "http://127.0.0.1:1/new", title), canGoBack: false })
  try {
    send("127.0.0.1:1/new")
    await flushPanels()
    send("Final page")
    await flushPanels()
    send("127.0.0.1:1/new")
    await flushPanels()
    const layout = JSON.parse((await persistent.get(`panels-${encodeDir(`new:${directory}`)}`, "layout"))!)
    expect(layout.tabs.find((tab: { id: string }) => tab.id === id)).toMatchObject({
      url: "http://127.0.0.1:1/new",
      title: "Final page",
    })
  } finally {
    await releaseBrowserState(id)
  }
})
