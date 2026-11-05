import { expect, test, vi } from "vitest"
import type { BrowserState } from "../../desktop/bridge-contract"
import { persistent } from "../../lib/persistence"
import { encodeDir } from "../../lib/route"
import { flushPanels, openPanel, promotePanels, selectPanels } from "./workspace"
import { releaseBrowserState } from "../browser/state"

const events = vi.hoisted(() => ({ state: (_state: BrowserState) => {} }))
vi.mock("../../lib/bridge", () => ({
  log: () => {},
  storage: {},
  bridge: {
    onBrowserState: (handler: (state: BrowserState) => void) => {
      events.state = handler
    },
    onBrowserConsole: () => {},
    storageGet: async (bucket: string, key: string) => localStorage.getItem(`${bucket}:${key}`),
    storageEntries: async (bucket: string) =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith(`${bucket}:`))
        .map((key) => [key.slice(bucket.length + 1), localStorage.getItem(key)!]),
    storageSet: async (bucket: string, key: string, value: string) => localStorage.setItem(`${bucket}:${key}`, value),
    storageRemove: async (bucket: string, key: string) => localStorage.removeItem(`${bucket}:${key}`),
  },
}))

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
    await promotion
    await finalWrite.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(flushed).toBe(false)
    finishWrite.resolve()
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
