import { expect, test, vi } from "vitest"
import type { BrowserState } from "../../desktop/bridge-contract"
import { persistent } from "../../lib/persistence"
import { encodeDir } from "../../lib/route"
import { flushPanels, openPanel, promotePanels, selectPanels } from "./workspace"
import { releaseBrowserState } from "../browser/state"

const events = vi.hoisted(() => ({ state: (_state: BrowserState) => {}, offline: new Set<string>() }))
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (input: string, init?: { headers?: HeadersInit }) => {
    const directory = decodeURIComponent(new Headers(init?.headers).get("x-merakcode-directory")!)
    if (events.offline.has(directory)) return new Response("directory unavailable", { status: 503 })
    const url = new URL(input)
    return Response.json(
      url.pathname === "/file/identity"
        ? { directory, path: url.searchParams.get("path") }
        : { directory, branches: [], current: null },
    )
  },
}))
vi.mock("../../lib/bridge", () => ({
  log: () => {},
  storage: {},
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

test.each([
  [false, false],
  [true, false],
  [true, true],
])(
  "background navigation survives controller eviction and an offline file directory (storage failure: %s, during flush: %s)",
  async (fail, duringFlush) => {
    const directory = "/evicted-browser-offline-file"
    const sessionID = crypto.randomUUID()
    const owner = await selectPanels({ directory, sessionID })
    await openPanel({ kind: "file", path: "notes.txt" })
    await openPanel({ kind: "browser", url: "https://example.invalid/old" })
    const id = owner.state.tabs.find((tab) => tab.kind === "browser")!.id
    const file = JSON.parse(JSON.stringify(owner.state.tabs[0]))
    for (let index = 0; index < 33; index++) await selectPanels({ directory, sessionID: crypto.randomUUID() })
    events.offline.add(directory)
    const set = persistent.set
    let attempts = 0
    const storage = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
      if (args[0] === `panels-${encodeDir(sessionID)}` && args[2].includes("/final") && ++attempts === 1 && fail)
        throw new Error("storage unavailable")
      return set(...args)
    })
    try {
      const flushing = duringFlush ? flushPanels() : undefined
      events.state({
        id,
        url: "https://example.invalid/final",
        title: "Final page",
        loading: false,
        canGoBack: true,
        canGoForward: false,
      })
      await (flushing ?? flushPanels())
      const stored = JSON.parse((await persistent.get(`panels-${encodeDir(sessionID)}`, "layout"))!)
      expect(stored.tabs).toContainEqual(file)
      expect(stored.tabs.find((tab: { id: string }) => tab.id === id)).toMatchObject({
        url: "https://example.invalid/final",
        title: "Final page",
      })
    } finally {
      storage.mockRestore()
      events.offline.delete(directory)
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
      events.state({
        id,
        url: "https://example.invalid/final",
        title: "Final",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      })
      await flushPanels()
      expect(await persistent.get("browser-owners", id)).toBe(raw)
    } finally {
      await releaseBrowserState(id)
    }
  },
)

test("failed browser owner registration is retried before a layout flush completes", async () => {
  const owner = await selectPanels({ directory: "/browser-owner-retry", sessionID: crypto.randomUUID() })
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
  const target = { directory, sessionID: crypto.randomUUID() }
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
    events.state({
      id,
      url: "https://example.invalid/final",
      title: "Final",
      loading: false,
      canGoBack: true,
      canGoForward: false,
    })
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
    events.state({
      id,
      url: "https://example.invalid/late",
      title: "Late",
      loading: false,
      canGoBack: true,
      canGoForward: false,
    })
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
  const send = (title: string) =>
    events.state({
      id,
      url: "http://127.0.0.1:1/new",
      title,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    })
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
