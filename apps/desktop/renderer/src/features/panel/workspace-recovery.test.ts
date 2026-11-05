import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { BrowserState } from "../../desktop/bridge-contract"

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

beforeEach(() => vi.resetModules())

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

test("a promoted layout is recovered after source cleanup fails and is never adopted by a second conversation", async () => {
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const before = await import("./workspace")
  const directory = "/promotion-restart"
  const target = { directory, sessionID: "chat-a" }
  const source = await before.selectPanels({ directory })
  await before.openPanel({ kind: "git", view: { commit: "draft belongs to A" } })
  await source.flush()
  const id = source.state.tabs[0]!.id
  const sourceBucket = `panels-${encodeDir(`new:${directory}`)}`
  const original = persistent.set
  const fail = vi.spyOn(persistent, "set").mockImplementation(async (bucket, key, value) => {
    if (bucket === sourceBucket && JSON.parse(value).tabs.length === 0) throw new Error("source cleanup failed")
    await original(bucket, key, value)
  })
  await expect(before.promotePanels(directory, target)).rejects.toThrow("source cleanup failed")
  fail.mockRestore()
  vi.resetModules()
  const after = await import("./workspace")
  expect((await after.selectPanels({ directory })).state.tabs).toEqual([])
  await after.promotePanels(directory, { directory, sessionID: "chat-b" })
  expect((await after.selectPanels({ directory, sessionID: "chat-b" })).state.tabs).toEqual([])
  expect((await after.selectPanels(target)).state.tabs).toMatchObject([
    { id, kind: "git", view: { commit: "draft belongs to A" } },
  ])
  vi.resetModules()
  const restarted = await import("./workspace")
  expect((await restarted.selectPanels({ directory })).state.tabs).toEqual([])
  expect((await restarted.selectPanels(target)).state.tabs).toHaveLength(1)
})

for (const stage of ["destination", "journal cleanup"])
  test(`recovery after failed ${stage} retains both commit drafts exactly once`, async () => {
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const before = await import("./workspace")
    const directory = `/promotion-${stage}`
    const target = { directory, sessionID: "destination" }
    const destination = await before.selectPanels(target)
    await before.openPanel({ kind: "git", view: { commit: "Existing draft" } })
    await destination.flush()
    const source = await before.selectPanels({ directory })
    await before.openPanel({ kind: "git", view: { commit: "Incoming draft" } })
    await before.openPanel({ kind: "plan" })
    await source.flush()
    const set = persistent.set
    const remove = persistent.remove
    vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
      if (stage === "destination" && args[0] === `panels-${encodeDir(target.sessionID)}`)
        throw new Error("Destination unavailable")
      await set(...args)
    })
    vi.spyOn(persistent, "remove").mockImplementation(async (...args) => {
      if (stage === "journal cleanup" && args[0] === "panel-transfers") throw new Error("Cleanup unavailable")
      await remove(...args)
    })
    await expect(before.promotePanels(directory, target)).rejects.toThrow("unavailable")
    vi.restoreAllMocks()
    vi.resetModules()
    const after = await import("./workspace")
    expect((await after.selectPanels({ directory })).state.tabs).toEqual([])
    const restored = await after.selectPanels(target)
    expect(restored.state.tabs.map((tab) => tab.kind)).toEqual(["git", "plan"])
    expect(restored.state.tabs[0]?.view).toMatchObject({
      commit: "Existing draft",
      commitAlternatives: ["Incoming draft"],
    })
    vi.resetModules()
    const again = await import("./workspace")
    expect((await again.selectPanels(target)).state.tabs).toEqual(restored.state.tabs)
  })

test("a rejected migration record leaves the source intact and permits an explicit retry", async () => {
  const { persistent } = await import("../../lib/persistence")
  const before = await import("./workspace")
  const directory = "/promotion-prepare"
  const target = { directory, sessionID: "target" }
  const source = await before.selectPanels({ directory })
  await before.openPanel({ kind: "git", view: { commit: "Keep until recorded" } })
  await source.flush()
  const original = persistent.set
  const fail = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
    if (args[0] === "panel-transfers") throw new Error("Record unavailable")
    await original(...args)
  })
  await expect(before.promotePanels(directory, target)).rejects.toThrow("Record unavailable")
  fail.mockRestore()
  vi.resetModules()
  const after = await import("./workspace")
  expect((await after.selectPanels({ directory })).state.tabs[0]?.view?.commit).toBe("Keep until recorded")
  expect((await after.selectPanels(target)).state.tabs).toEqual([])
  await after.promotePanels(directory, target)
  expect((await after.selectPanels(target)).state.tabs[0]?.view?.commit).toBe("Keep until recorded")
  expect((await after.selectPanels({ directory })).state.tabs).toEqual([])
})

for (const stage of ["destination", "startup event", "owner registration", "journal cleanup"])
  test(`navigation after failed ${stage} survives migration recovery and a second restart`, async () => {
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const before = await import("./workspace")
    const directory = `/browser-recovery-${stage}`
    const target = { directory, sessionID: "original-owner" }
    const source = await before.selectPanels({ directory })
    await before.openPanel({ kind: "browser", url: "https://example.invalid/old", title: "Old" })
    await source.flush()
    const id = source.state.tabs[0]!.id
    const set = persistent.set
    const remove = persistent.remove
    vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
      if (
        ((stage === "destination" || stage === "startup event") &&
          args[0] === `panels-${encodeDir(target.sessionID)}`) ||
        (stage === "owner registration" && args[0] === "browser-owners")
      )
        throw new Error("Write unavailable")
      await set(...args)
    })
    vi.spyOn(persistent, "remove").mockImplementation(async (...args) => {
      if (stage === "journal cleanup" && args[0] === "panel-transfers") throw new Error("Cleanup unavailable")
      await remove(...args)
    })
    await expect(before.promotePanels(directory, target)).rejects.toThrow("unavailable")
    if (stage === "startup event") {
      vi.restoreAllMocks()
      vi.resetModules()
      await import("./workspace")
    }
    events.state({
      id,
      url: "https://example.invalid/final",
      title: "Final",
      loading: false,
      canGoBack: true,
      canGoForward: false,
    })
    const owner = stage === "destination" || stage === "startup event" ? `new:${directory}` : target.sessionID
    await vi.waitFor(async () =>
      expect(JSON.parse((await persistent.get(`panels-${encodeDir(owner)}`, "layout"))!).tabs[0].url).toBe(
        "https://example.invalid/final",
      ),
    )
    vi.restoreAllMocks()
    vi.resetModules()
    const after = await import("./workspace")
    const restored = await after.selectPanels(target)
    expect(restored.state.tabs).toMatchObject([
      { id, kind: "browser", url: "https://example.invalid/final", title: "Final" },
    ])
    expect((await after.selectPanels({ directory })).state.tabs).toEqual([])
    expect(await (await import("../../lib/persistence")).persistent.entries("panel-transfers")).toEqual([])
    vi.resetModules()
    expect((await (await import("./workspace")).selectPanels(target)).state.tabs).toEqual(restored.state.tabs)
  })
