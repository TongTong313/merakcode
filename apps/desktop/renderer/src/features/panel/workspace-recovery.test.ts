import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import type { BrowserState } from "../../desktop/bridge-contract"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"

const events = vi.hoisted(() => ({
  state: (_state: BrowserState) => {},
  close: async (_id: string) => true,
  entries: async (_bucket: string) => {},
}))
// The Go engine answers every request for real. These hooks only hold or fail a request before it is forwarded
// (the engine has no way to be told to stall), so a test can observe the recovery code while a lookup is pending.
const hooks = vi.hoisted(() => ({
  lookup: async (): Promise<void | (() => void)> => {},
  unavailable: false,
  identity: async (_path: string) => {},
  save: async () => {},
}))
// The code editor is a browser component; a plain text model stands in for it. Everything else is real.
vi.mock("../../lib/monaco", () => ({
  monaco: {
    Uri: { parse: (value: string) => value },
    editor: {
      createModel: (initial: string) => {
        let value = initial
        const listeners: Array<() => void> = []
        return {
          getValue: () => value,
          setValue: (next: string) => {
            value = next
            listeners.forEach((fn) => fn())
          },
          onDidChangeContent: (fn: () => void) => listeners.push(fn),
          dispose() {},
        }
      },
    },
  },
}))
// Electron is absent in tests: its preload bridge is replaced by storage in localStorage and a recorded close.
vi.mock("../../lib/bridge", () => ({
  log: () => {},
  storage: {},
  mac: false,
  bridge: {
    onBrowserState: (handler: (state: BrowserState) => void) => {
      events.state = handler
    },
    onBrowserConsole: () => {},
    browserClose: (id: string) => events.close(id),
    storageGet: async (bucket: string, key: string) => localStorage.getItem(`${bucket}:${key}`),
    storageBuckets: async () => [...new Set(Object.keys(localStorage).map((key) => key.split(":")[0]!))],
    storageEntries: async (bucket: string) => {
      const entries = Object.keys(localStorage)
        .filter((key) => key.startsWith(`${bucket}:`))
        .map((key) => [key.slice(bucket.length + 1), localStorage.getItem(key)!])
      await events.entries(bucket)
      return entries
    },
    storageSet: async (bucket: string, key: string, value: string) => localStorage.setItem(`${bucket}:${key}`, value),
    storageRemove: async (bucket: string, key: string) => localStorage.removeItem(`${bucket}:${key}`),
  },
}))

let env: Awaited<ReturnType<typeof engineFixture>>
let engine: Awaited<ReturnType<typeof client>>
const attached = new WeakSet<object>()
let folders = 0
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
  engine = await client()
}, 120_000)
afterAll(async () => {
  try {
    const { client: current } = await import("../../state/client")
    await (await current()).close()
    await engine.close()
  } finally {
    await env?.close()
  }
})

beforeEach(() => {
  vi.resetModules()
  events.close = async () => true
  events.entries = async () => {}
  hooks.lookup = async () => {}
  hooks.unavailable = false
  hooks.identity = async () => {}
  hooks.save = async () => {}
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

/** Imports the workspace module of the current module generation and hooks the connection that generation opened. */
async function load() {
  const workspace = await import("./workspace")
  const connection = await (await import("../../state/client")).client()
  if (!attached.has(connection)) {
    attached.add(connection)
    const list = connection.session.list.bind(connection.session)
    connection.session.list = (async (...args: Parameters<typeof list>) => {
      const done = await hooks.lookup()
      if (hooks.unavailable) throw new Error("MRK-1001")
      const result = await list(...args)
      done?.()
      return result
    }) as typeof list
    const identity = connection.file.identity.bind(connection.file)
    connection.file.identity = (async (...args: Parameters<typeof identity>) => {
      await hooks.identity(args[0].path)
      return identity(...args)
    }) as typeof identity
    const write = connection.file.write.bind(connection.file)
    connection.file.write = (async (...args: Parameters<typeof write>) => {
      await hooks.save()
      return write(...args)
    }) as typeof write
  }
  return workspace
}

/** A conversation the engine really knows; an unknown id is a deleted one. */
const chat = async () =>
  (await engine.session.create({ provider: "fake", model: "test", workdir: env.project })).session
/** A real folder outside the repository, with a notes file the editor can open. */
async function folder(name: string) {
  const directory = path.join(path.dirname(env.project), `${name}-${++folders}`)
  await mkdir(directory)
  await writeFile(path.join(directory, "notes.txt"), "Original content")
  return directory
}
const browserState = (id: string, url: string, title: string): BrowserState => ({
  id,
  url,
  title,
  loading: false,
  canGoBack: true,
  canGoForward: false,
})

test.each(["journal", "destination", "source cleanup"])(
  "deleting a conversation cancels a failed %s transfer across flush and two restarts",
  async (stage) => {
    const workspace = await load()
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const directory = `/delete-transfer-${stage}`
    const target = { directory, sessionID: "deleted-chat" }
    const source = await workspace.selectPanels({ directory })
    await workspace.openPanel({ kind: "git", view: { commit: "Discard with the deleted conversation" } })
    await source.flush()
    const set = persistent.set
    const failure = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
      if (
        (stage === "journal" && args[0] === "panel-transfers") ||
        (stage === "destination" && args[0] === `panels-${encodeDir(target.sessionID)}`) ||
        (stage === "source cleanup" &&
          args[0] === `panels-${encodeDir(`new:${directory}`)}` &&
          JSON.parse(args[2]).tabs.length === 0)
      )
        throw new Error("Transfer write failed")
      await set(...args)
    })
    await expect(workspace.promotePanels(directory, target)).rejects.toThrow("Transfer write failed")
    failure.mockRestore()
    await workspace.releasePanels(target, true)
    await workspace.flushPanels()
    expect((await workspace.selectPanels(target)).state.tabs).toEqual([])
    expect(await persistent.entries("panel-transfers")).toEqual([])
    for (let restart = 0; restart < 2; restart++) {
      vi.resetModules()
      const restored = await load()
      expect((await restored.selectPanels(target)).state.tabs).toEqual([])
      expect((await restored.selectPanels({ directory })).state.tabs).toEqual([])
    }
  },
)

test("a cancelled transfer rejects late opens and browser writes while cleanup is unavailable", async () => {
  const workspace = await load()
  const { persistent } = await import("../../lib/persistence")
  const directory = "/cancel-browser-retry"
  const target = { directory, sessionID: "deleted-browser-chat" }
  const source = await workspace.selectPanels({ directory })
  await workspace.openPanel({ kind: "browser", url: "https://example.invalid/old" })
  const id = source.state.tabs[0]!.id
  const set = persistent.set
  const failure = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
    if (args[0] === "panel-transfers") throw new Error("Journal unavailable")
    await set(...args)
  })
  await expect(workspace.promotePanels(directory, target)).rejects.toThrow("Journal unavailable")
  failure.mockRestore()
  events.close = async () => false
  await expect(workspace.releasePanels(target, true)).rejects.toThrow("MRK-7013")
  const cancelled = await persistent.get("panel-transfers", target.sessionID)
  expect(JSON.parse(cancelled!).cancelled).toBe(true)
  events.state(browserState(id, "https://example.invalid/late", "Late"))
  await expect(workspace.openPanel({ kind: "git" })).rejects.toThrow("MRK-4025")
  expect(await persistent.get("panel-transfers", target.sessionID)).toBe(cancelled)
  events.close = async () => true
  vi.resetModules()
  const restored = await load()
  expect((await restored.selectPanels(target)).state.tabs).toEqual([])
  expect((await restored.selectPanels({ directory })).state.tabs).toEqual([])
  expect(await persistent.entries("panel-transfers")).toEqual([])
  expect(await persistent.entries("browser-owners")).toEqual([])
})

test.each(["source", "destination"])("deletion is durable before reading an unavailable %s layout", async (stage) => {
  const workspace = await load()
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const directory = "/cancel-before-read"
  const target = { directory, sessionID: "deleted-unreadable-chat" }
  await workspace.selectPanels({ directory })
  await workspace.openPanel({ kind: "git", view: { commit: "Discard on deletion" } })
  const set = persistent.set
  const failure = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
    if (args[0] === `panels-${encodeDir(target.sessionID)}`) throw new Error("Destination unavailable")
    await set(...args)
  })
  await expect(workspace.promotePanels(directory, target)).rejects.toThrow("Destination unavailable")
  failure.mockRestore()
  vi.resetModules()
  const after = await load()
  const storage = await import("../../lib/persistence")
  const get = storage.persistent.get
  const unavailable = vi.spyOn(storage.persistent, "get").mockImplementation(async (...args) => {
    if (args[0] === `panels-${encodeDir(stage === "source" ? `new:${directory}` : target.sessionID)}`)
      throw new Error("Read unavailable")
    return get(...args)
  })
  await expect(after.releasePanels(target, true)).rejects.toThrow("Read unavailable")
  expect(JSON.parse((await get("panel-transfers", target.sessionID))!).cancelled).toBe(true)
  unavailable.mockRestore()
  vi.resetModules()
  const restarted = await load()
  expect((await restarted.selectPanels(target)).state.tabs).toEqual([])
  expect((await restarted.selectPanels({ directory })).state.tabs).toEqual([])
})

test("a temporary target lookup failure preserves the journal and drafts until recovery succeeds", async () => {
  const workspace = await load()
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const directory = "/lookup-retry"
  const target = { directory, sessionID: await chat() }
  await workspace.selectPanels({ directory })
  await workspace.openPanel({ kind: "git", view: { commit: "Keep after network retry" } })
  const set = persistent.set
  const failure = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
    if (args[0] === `panels-${encodeDir(target.sessionID)}`) throw new Error("Destination unavailable")
    await set(...args)
  })
  await expect(workspace.promotePanels(directory, target)).rejects.toThrow("Destination unavailable")
  failure.mockRestore()
  const raw = await persistent.get("panel-transfers", target.sessionID)
  hooks.unavailable = true
  vi.resetModules()
  const restarted = await load()
  await expect(restarted.selectPanels(target)).rejects.toThrow()
  expect(await persistent.get("panel-transfers", target.sessionID)).toBe(raw)
  hooks.unavailable = false
  expect((await restarted.selectPanels(target)).state.tabs[0]?.view?.commit).toBe("Keep after network retry")
})

test.each(["destination", "source cleanup", "owner registration"])(
  "an offline failed %s transfer leaves unrelated conversations usable across restarts",
  async (stage) => {
    const workspace = await load()
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const directory = "/offline-promotion"
    const target = { directory, sessionID: await chat() }
    const destination = await workspace.selectPanels(target)
    await workspace.openPanel({ kind: "git", view: { commit: "Existing draft" } })
    await destination.flush()
    const source = await workspace.selectPanels({ directory })
    await workspace.openPanel({ kind: "git", view: { commit: "Incoming draft" } })
    await workspace.openPanel({ kind: "browser", url: "https://example.invalid/offline-transfer" })
    await source.flush()
    const sourceBucket = `panels-${encodeDir(`new:${directory}`)}`
    const set = persistent.set
    const failure = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
      if (
        (stage === "destination" && args[0] === `panels-${encodeDir(target.sessionID)}`) ||
        (stage === "owner registration" && args[0] === "browser-owners" && args[2].includes(target.sessionID)) ||
        (stage === "source cleanup" && args[0] === sourceBucket && JSON.parse(args[2]).tabs.length === 0)
      )
        throw new Error("Transfer write unavailable")
      await set(...args)
    })
    await expect(workspace.promotePanels(directory, target)).rejects.toThrow("Transfer write unavailable")
    const sibling = { directory, sessionID: "unrelated-during-write-failure" }
    const healthy = await workspace.selectPanels(sibling)
    await workspace.openPanel({ kind: "browser", url: "https://example.invalid/healthy" })
    expect(healthy.state.tabs).toMatchObject([{ kind: "browser", url: "https://example.invalid/healthy" }])
    await workspace.releasePanels(sibling, true)
    expect((await workspace.selectPanels(sibling)).state.tabs).toEqual([])
    failure.mockRestore()
    const journal = await persistent.get("panel-transfers", target.sessionID)
    const original = await persistent.get(sourceBucket, "layout")
    hooks.unavailable = true
    for (let restart = 0; restart < 2; restart++) {
      vi.resetModules()
      const restored = await load()
      for (const healthy of [directory, "/healthy-promotion"]) {
        const state = await restored.selectPanels({ directory: healthy, sessionID: `healthy:${healthy}` })
        await restored.openPanel({ kind: "git", view: { commit: "Healthy draft" } })
        await state.flush()
        expect(state.state.tabs).toMatchObject([{ kind: "git", view: { commit: "Healthy draft" } }])
      }
      await restored.flushPanels()
      expect(await persistent.get("panel-transfers", target.sessionID)).toBe(journal)
      expect(await persistent.get(sourceBucket, "layout")).toBe(original)
      await expect(restored.selectPanels(target)).rejects.toThrow()
    }
    hooks.unavailable = false
    const restored = await import("./workspace")
    const result = await restored.selectPanels(target)
    expect(result.state.tabs).toMatchObject([
      { kind: "git", view: { commit: "Existing draft", commitAlternatives: ["Incoming draft"] } },
      { kind: "browser", url: "https://example.invalid/offline-transfer" },
    ])
    expect((await restored.selectPanels({ directory })).state.tabs).toEqual([])
    expect(await persistent.entries("panel-transfers")).toEqual([])
    vi.resetModules()
    expect((await (await load()).selectPanels(target)).state.tabs).toEqual(result.state.tabs)
  },
)

test("unrelated selections do not await a cancellation record while shutdown still drains that write", async () => {
  const { persistent } = await import("../../lib/persistence")
  await persistent.set(
    "panel-transfers",
    "cancel-record",
    JSON.stringify({
      version: 1,
      sourceContext: { directory: "/cancel-record" },
      target: { directory: "/cancel-record", sessionID: "cancel-record" },
      snapshot: { version: 1, tabs: [] },
      cancelled: true,
    }),
  )
  const workspace = await load()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const set = persistent.set
  const delayed = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
    if (args[0] === "panel-transfers") {
      entered.resolve()
      await gate.promise
    }
    return set(...args)
  })
  let flushing: Promise<void> | undefined
  try {
    await workspace.selectPanels({ directory: "/healthy", sessionID: "first" })
    await entered.promise
    const selected = workspace.selectPanels({ directory: "/healthy", sessionID: "second" })
    const opening = workspace.openPanel({ kind: "git" })
    await vi.waitFor(() => expect(workspace.panels()?.state.tabs[0]?.kind).toBe("git"))
    await Promise.all([selected, opening])
    let flushed = false
    flushing = workspace.flushPanels().then(() => {
      flushed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(flushed).toBe(false)
  } finally {
    gate.resolve()
    await flushing
    delayed.mockRestore()
  }
  await vi.waitFor(async () => expect(await persistent.entries("panel-transfers")).toEqual([]))
})

test.each(["journal", "layout"])(
  "background navigation and unrelated deletion survive an offline transfer and a failed %s write",
  async (stage) => {
    const before = await load()
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const healthy = { directory: "/healthy-browser", sessionID: await chat() }
    const healthyState = await before.selectPanels(healthy)
    await before.openPanel({ kind: "browser", url: "https://example.invalid/healthy-old" })
    await healthyState.flush()
    const healthyID = healthyState.state.tabs[0]!.id
    const directory = "/offline-browser-transfer"
    const target = { directory, sessionID: await chat() }
    const source = await before.selectPanels({ directory })
    await before.openPanel({ kind: "git", view: { commit: "Keep offline draft" } })
    await before.openPanel({ kind: "browser", url: "https://example.invalid/offline-old" })
    await source.flush()
    const id = source.state.tabs[1]!.id
    const sourceBucket = `panels-${encodeDir(`new:${directory}`)}`
    const set = persistent.set
    const failure = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
      if (args[0] === `panels-${encodeDir(target.sessionID)}`) throw new Error("Destination unavailable")
      await set(...args)
    })
    await expect(before.promotePanels(directory, target)).rejects.toThrow("Destination unavailable")
    failure.mockRestore()
    hooks.unavailable = true
    vi.resetModules()
    const restored = await load()
    const storage = (await import("../../lib/persistence")).persistent
    const write = storage.set
    let failed = false
    vi.spyOn(storage, "set").mockImplementation(async (...args) => {
      if (
        !failed &&
        args[2].includes("/offline-final") &&
        args[0] === (stage === "journal" ? "panel-transfers" : sourceBucket)
      ) {
        failed = true
        throw new Error("Navigation write unavailable")
      }
      await write(...args)
    })
    for (const [browserID, name] of [
      [id, "offline"],
      [healthyID, "healthy"],
    ])
      events.state(browserState(browserID!, `https://example.invalid/${name}-final`, `${name} final`))
    await restored.flushPanels()
    expect(failed).toBe(true)
    const saved = JSON.parse((await storage.get(sourceBucket, "layout"))!)
    expect(saved.tabs).toMatchObject([
      { kind: "git", view: { commit: "Keep offline draft" } },
      { id, kind: "browser", url: "https://example.invalid/offline-final", title: "offline final" },
    ])
    const journal = JSON.parse((await storage.get("panel-transfers", target.sessionID))!)
    expect(journal.snapshot.tabs[1]).toMatchObject({ id, url: "https://example.invalid/offline-final" })
    expect((await restored.selectPanels(healthy)).state.tabs[0]?.url).toBe("https://example.invalid/healthy-final")
    const closed: string[] = []
    events.close = async (id) => {
      closed.push(id)
      return true
    }
    await restored.releasePanels(healthy, true)
    expect(closed).toEqual([healthyID])
    events.state(browserState(healthyID, "https://example.invalid/late", "Late"))
    await restored.flushPanels()
    expect((await restored.selectPanels(healthy)).state.tabs).toEqual([])
    hooks.unavailable = false
    vi.resetModules()
    const restarted = await load()
    expect((await restarted.selectPanels(target)).state.tabs).toMatchObject(saved.tabs)
    expect(await storage.entries("panel-transfers")).toEqual([])
  },
)

test.each([false, true])(
  "a deleted promotion target cannot prevent fresh opens when deletion is queued: %s",
  async (queued) => {
    const workspace = await load()
    const directory = "/delete-late-promotion"
    const target = { directory, sessionID: "deleted-late-target" }
    await workspace.selectPanels({ directory })
    await workspace.openPanel({ kind: "git", view: { commit: "Keep the fresh draft" } })
    const removing = workspace.releasePanels(target, true)
    if (!queued) await removing
    const late = workspace.promotePanels(directory, target)
    const later = workspace.promotePanels(directory, target)
    const opening = workspace.openPanel({ kind: "browser", url: "https://example.invalid/fresh" })
    await Promise.all([
      removing,
      expect(late).rejects.toThrow("MRK-4025"),
      expect(later).rejects.toThrow("MRK-4025"),
      opening,
    ])
    await workspace.flushPanels()
    const fresh = await workspace.selectPanels({ directory })
    await workspace.openPanel({ kind: "terminal" })
    expect(fresh.state.tabs.map((tab) => tab.kind)).toEqual(["git", "browser", "terminal"])
    expect(fresh.state.tabs[0]?.view?.commit).toBe("Keep the fresh draft")
    expect((await workspace.selectPanels(target)).state.tabs).toEqual([])
  },
)

test("a rejected stale promotion preserves a newer target and its retry after a storage failure", async () => {
  const workspace = await load()
  const { persistent } = await import("../../lib/persistence")
  const directory = "/newer-promotion-retry"
  const deleted = { directory, sessionID: "deleted-before-newer-promotion" }
  const target = { directory, sessionID: await chat() }
  await workspace.selectPanels({ directory })
  await workspace.openPanel({ kind: "git", view: { commit: "Keep the newer draft" } })
  const removing = workspace.releasePanels(deleted, true)
  const stale = workspace.promotePanels(directory, deleted)
  const set = persistent.set
  const failure = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
    if (args[0] === "panel-transfers") throw new Error("Journal unavailable")
    await set(...args)
  })
  const newer = workspace.promotePanels(directory, target)
  await Promise.all([
    removing,
    expect(stale).rejects.toThrow("MRK-4025"),
    expect(newer).rejects.toThrow("Journal unavailable"),
  ])
  failure.mockRestore()
  await workspace.openPanel({ kind: "browser", url: "https://example.invalid/newer" })
  await workspace.openPanel({ kind: "terminal" })
  await workspace.flushPanels()
  const restored = await workspace.selectPanels(target)
  expect(restored.state.tabs.map((tab) => tab.kind)).toEqual(["git", "browser", "terminal"])
  expect(restored.state.tabs[0]?.view?.commit).toBe("Keep the newer draft")
  expect((await workspace.selectPanels({ directory })).state.tabs).toEqual([])
  expect((await workspace.selectPanels(deleted)).state.tabs).toEqual([])
  expect(await persistent.entries("panel-transfers")).toEqual([])
})

test("a delayed promotion retry cannot move new drafts into a conversation deleted from another route", async () => {
  const workspace = await load()
  const directory = "/delete-stale-retry"
  const target = { directory, sessionID: await chat() }
  await workspace.selectPanels({ directory })
  await workspace.openPanel({ kind: "git", view: { commit: "Original draft" } })
  await workspace.promotePanels(directory, target)
  await workspace.selectPanels({ directory, sessionID: "sibling" })
  await workspace.releasePanels(target, true)
  const fresh = await workspace.selectPanels({ directory })
  await workspace.openPanel({ kind: "git", view: { commit: "New unrelated draft" } })
  await expect(workspace.promotePanels(directory, target)).rejects.toThrow("MRK-4025")
  expect(fresh.state.tabs[0]?.view?.commit).toBe("New unrelated draft")
  expect((await workspace.selectPanels(target)).state.tabs).toEqual([])
})

test.each([false, true])(
  "cancelling the selected source permits fresh opens after a rebuild failure: %s",
  async (unavailable) => {
    const workspace = await load()
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const directory = "/cancel-selected-source"
    const target = { directory, sessionID: await chat() }
    await workspace.selectPanels({ directory })
    await workspace.openPanel({ kind: "git", view: { commit: "Deleted draft" } })
    const set = persistent.set
    const failure = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
      if (args[0] === "panel-transfers") throw new Error("Journal unavailable")
      await set(...args)
    })
    await expect(workspace.promotePanels(directory, target)).rejects.toThrow("Journal unavailable")
    failure.mockRestore()
    const get = persistent.get
    const read = vi.spyOn(persistent, "get").mockImplementation(async (...args) => {
      const raw = await get(...args)
      if (unavailable && args[0] === `panels-${encodeDir(`new:${directory}`)}` && JSON.parse(raw!).tabs.length === 0)
        throw new Error("Source read unavailable")
      return raw
    })
    const removing = workspace.releasePanels(target, true)
    const late = expect(workspace.openPanel({ kind: "terminal" })).rejects.toThrow("MRK-4025")
    await Promise.all([unavailable ? expect(removing).rejects.toThrow("Source read unavailable") : removing, late])
    read.mockRestore()
    if (unavailable) await workspace.releasePanels(target, true)
    const fresh = await workspace.selectPanels({ directory })
    await workspace.openPanel({ kind: "git", view: { commit: "New unrelated draft" } })
    expect(fresh.state.tabs).toMatchObject([{ kind: "git", view: { commit: "New unrelated draft" } }])
    expect((await workspace.selectPanels(target)).state.tabs).toEqual([])
  },
)

test.each(["target", "sibling"])(
  "recovery from the %s retries an unwritten cancellation of a deleted target",
  async (visit) => {
    const workspace = await load()
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const directory = "/delete-unwritten-cancellation"
    const target = { directory, sessionID: await chat() }
    await workspace.selectPanels({ directory })
    await workspace.openPanel({ kind: "git", view: { commit: "Discard with deletion" } })
    const set = persistent.set
    const failure = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
      if (
        args[0] === `panels-${encodeDir(target.sessionID)}` ||
        (args[0] === "panel-transfers" && JSON.parse(args[2]).cancelled)
      )
        throw new Error("Storage unavailable")
      await set(...args)
    })
    await expect(workspace.promotePanels(directory, target)).rejects.toThrow("Storage unavailable")
    await engine.session.delete({ session: target.sessionID })
    await expect(workspace.releasePanels(target, true)).rejects.toThrow("Storage unavailable")
    expect(JSON.parse((await persistent.get("panel-transfers", target.sessionID))!).cancelled).toBeUndefined()
    failure.mockRestore()
    vi.resetModules()
    const restarted = await load()
    if (visit === "sibling") {
      await restarted.selectPanels({ directory, sessionID: "healthy-sibling" })
      await vi.waitFor(async () => expect(await persistent.entries("panel-transfers")).toEqual([]))
    }
    expect((await restarted.selectPanels(target)).state.tabs).toEqual([])
    expect((await restarted.selectPanels({ directory })).state.tabs).toEqual([])
  },
)

test.each(["browser", "identity"])(
  "background cancellation waiting for %s leaves unrelated opens and shutdown persistence usable",
  async (stage) => {
    const before = await load()
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const directory = await folder("cancel-background")
    const target = { directory, sessionID: "cancel-background-target" }
    await before.selectPanels({ directory })
    await before.openPanel({ kind: "file", path: "notes.txt" })
    await before.openPanel({ kind: "browser", url: "https://example.invalid/closed" })
    await (
      await import("../code/draft")
    ).writeDraft(directory, "notes.txt", {
      content: "Keep shared file draft",
      saved: "Original content",
    })
    const set = persistent.set
    const failure = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
      if (args[0] === `panels-${encodeDir(target.sessionID)}`) throw new Error("Destination unavailable")
      await set(...args)
    })
    await expect(before.promotePanels(directory, target)).rejects.toThrow("Destination unavailable")
    failure.mockRestore()
    events.close = async () => false
    await expect(before.releasePanels(target, true)).rejects.toThrow("MRK-7013")
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    events.close = async () => {
      if (stage === "browser") {
        entered.resolve()
        await gate.promise
      }
      return true
    }
    hooks.identity = async () => {
      if (stage === "identity") {
        entered.resolve()
        await gate.promise
      }
    }
    vi.resetModules()
    const after = await load()
    try {
      const healthy = await after.selectPanels({ directory: "/healthy", sessionID: "healthy-background" })
      await entered.promise
      const opening = after.openPanel({ kind: "git", view: { commit: "Healthy while cleanup waits" } })
      await vi.waitFor(() => expect(healthy.state.tabs[0]?.view?.commit).toBe("Healthy while cleanup waits"))
      await opening
      if (stage === "browser") await after.openPanel({ kind: "file", fileDirectory: directory, path: "notes.txt" })
      await after.flushPanels()
      expect(JSON.parse((await persistent.get("panel-transfers", target.sessionID))!).cancelled).toBe(true)
    } finally {
      gate.resolve()
    }
    await vi.waitFor(async () => expect(await persistent.entries("panel-transfers")).toEqual([]))
    expect((await (await import("../code/draft")).readDraft(directory, "notes.txt"))?.content).toBe(
      stage === "browser" ? "Keep shared file draft" : undefined,
    )
    expect((await after.selectPanels({ directory })).state.tabs).toEqual([])
  },
)

test.each(["file-links-", "draft-"])(
  "new %s records from another window defer cancellation without remote work in the operation queue",
  async (prefix) => {
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const directory = await folder("cancel-cold-record")
    const source = `new:${directory}`
    const snapshot = {
      version: 1,
      directory,
      tabs: [
        { id: "file", kind: "file", path: "notes.txt", fileDirectory: directory },
        { id: "browser", kind: "browser", url: "https://example.invalid/closed" },
      ],
    }
    await persistent.set(`panels-${encodeDir(source)}`, "layout", JSON.stringify(snapshot))
    await persistent.set(`file-links-${encodeDir(directory)}`, "notes.txt", JSON.stringify([source]))
    await persistent.set(
      "panel-transfers",
      "deleted-cold-record",
      JSON.stringify({
        version: 1,
        sourceContext: { directory },
        target: { directory, sessionID: "deleted-cold-record" },
        snapshot,
        cancelled: true,
      }),
    )
    const entered = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const remote = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let closed = false
    let held = false
    let queries = 0
    events.close = async () => {
      closed = true
      return true
    }
    events.entries = async (bucket) => {
      if (!closed || held || bucket !== `draft-${encodeDir(directory)}`) return
      held = true
      entered.resolve()
      await ready.promise
    }
    hooks.identity = async (path) => {
      if (path !== "cold.txt") return
      queries++
      remote.resolve()
      await finish.promise
    }
    const workspace = await load()
    let closing: Promise<void> | undefined
    try {
      const healthy = await workspace.selectPanels({ directory: "/healthy", sessionID: "cold-record-sibling" })
      await entered.promise
      const raw = JSON.stringify(
        prefix === "file-links-"
          ? ["another-window"]
          : { version: 1, content: "Keep other window draft", saved: "Original" },
      )
      await persistent.set(`${prefix}${encodeDir(directory)}`, "cold.txt", raw)
      ready.resolve()
      const opening = workspace.openPanel({ kind: "git" })
      await vi.waitFor(() => expect(healthy.state.tabs).toMatchObject([{ kind: "git" }]))
      await opening
      let flushed = false
      closing = (await import("../code/draft"))
        .flushDrafts()
        .then(() => workspace.flushPanels())
        .then(() => {
          flushed = true
        })
      await vi.waitFor(() => expect(flushed).toBe(true))
      expect(queries).toBe(0)
      expect(await persistent.get("panel-transfers", "deleted-cold-record")).not.toBeNull()
      await workspace.selectPanels({ directory: "/healthy", sessionID: "retry-cold-record" })
      await remote.promise
      const reopened = workspace.openPanel({ kind: "browser", url: "https://example.invalid/healthy" })
      await vi.waitFor(() => expect(workspace.panels()?.state.tabs[0]?.kind).toBe("browser"))
      await reopened
      await workspace.flushPanels()
      expect(await persistent.get(`${prefix}${encodeDir(directory)}`, "cold.txt")).toBe(raw)
    } finally {
      ready.resolve()
      finish.resolve()
      await closing
    }
    await vi.waitFor(async () => expect(await persistent.entries("panel-transfers")).toEqual([]))
  },
)

test("a file save accepted before background cancellation leaves unrelated opens usable", async () => {
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const { buffersFor } = await import("../code/state")
  const { flushDrafts } = await import("../code/draft")
  const directory = await folder("save-before-cancellation")
  const source = `new:${directory}`
  const snapshot = {
    version: 1,
    directory,
    tabs: [
      { id: "file", kind: "file", path: "notes.txt", fileDirectory: directory },
      { id: "browser", kind: "browser", url: "https://example.invalid/closing" },
    ],
  }
  await persistent.set(`panels-${encodeDir(source)}`, "layout", JSON.stringify(snapshot))
  await persistent.set(`file-links-${encodeDir(directory)}`, "notes.txt", JSON.stringify([source]))
  await persistent.set(
    "panel-transfers",
    "deleted-saving",
    JSON.stringify({
      version: 1,
      sourceContext: { directory },
      target: { directory, sessionID: "deleted-saving" },
      snapshot,
      cancelled: true,
    }),
  )
  const workspace = await load()
  const buffer = buffersFor(directory)
  await buffer.open("notes.txt")
  buffer.tabs[0]!.model!.setValue("Accepted save")
  await flushDrafts()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  hooks.save = async () => {
    entered.resolve()
    await gate.promise
  }
  const saving = buffer.save(false, "notes.txt")
  await entered.promise
  const cancelling = Promise.withResolvers<void>()
  events.close = async () => {
    cancelling.resolve()
    return true
  }
  try {
    const healthy = await workspace.selectPanels({ directory: "/healthy", sessionID: "save-sibling" })
    await cancelling.promise
    // Let cancellation continue past resource closure before admitting an unrelated open.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const opening = workspace.openPanel({ kind: "git", view: { commit: "Healthy during save" } })
    await vi.waitFor(() => expect(healthy.state.tabs[0]?.view?.commit).toBe("Healthy during save"))
    await opening
    await workspace.flushPanels()
    expect(await persistent.get("panel-transfers", "deleted-saving")).not.toBeNull()
  } finally {
    gate.resolve()
    await saving
  }
  await vi.waitFor(async () => expect(await persistent.entries("panel-transfers")).toEqual([]))
})

test("a promoted layout is recovered after source cleanup fails and is never adopted by a second conversation", async () => {
  const before = await load()
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const directory = "/promotion-restart"
  const target = { directory, sessionID: await chat() }
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
  const after = await load()
  expect((await after.selectPanels({ directory })).state.tabs).toEqual([])
  const second = { directory, sessionID: await chat() }
  await after.promotePanels(directory, second)
  expect((await after.selectPanels(second)).state.tabs).toEqual([])
  expect((await after.selectPanels(target)).state.tabs).toMatchObject([
    { id, kind: "git", view: { commit: "draft belongs to A" } },
  ])
  vi.resetModules()
  const restarted = await load()
  expect((await restarted.selectPanels({ directory })).state.tabs).toEqual([])
  expect((await restarted.selectPanels(target)).state.tabs).toHaveLength(1)
})

for (const stage of ["destination", "journal cleanup"])
  test(`recovery after failed ${stage} retains both commit drafts exactly once`, async () => {
    const before = await load()
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const directory = `/promotion-${stage}`
    const target = { directory, sessionID: await chat() }
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
    const after = await load()
    expect((await after.selectPanels({ directory })).state.tabs).toEqual([])
    const restored = await after.selectPanels(target)
    expect(restored.state.tabs.map((tab) => tab.kind)).toEqual(["git", "plan"])
    expect(restored.state.tabs[0]?.view).toMatchObject({
      commit: "Existing draft",
      commitAlternatives: ["Incoming draft"],
    })
    vi.resetModules()
    const again = await load()
    expect((await again.selectPanels(target)).state.tabs).toEqual(restored.state.tabs)
  })

test("a rejected migration record leaves the source intact and permits an explicit retry", async () => {
  const before = await load()
  const { persistent } = await import("../../lib/persistence")
  const directory = "/promotion-prepare"
  const target = { directory, sessionID: await chat() }
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
  const after = await load()
  expect((await after.selectPanels({ directory })).state.tabs[0]?.view?.commit).toBe("Keep until recorded")
  expect((await after.selectPanels(target)).state.tabs).toEqual([])
  await after.promotePanels(directory, target)
  expect((await after.selectPanels(target)).state.tabs[0]?.view?.commit).toBe("Keep until recorded")
  expect((await after.selectPanels({ directory })).state.tabs).toEqual([])
})

test.each(["initial flush", "journal", "destination", "source cleanup", "journal cleanup"])(
  "opens reject a failed %s and can be retried without losing or duplicating tabs",
  async (stage) => {
    const workspace = await load()
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const directory = `/open-retry-${stage}`
    const target = { directory, sessionID: await chat() }
    const source = await workspace.selectPanels({ directory })
    await workspace.openPanel({ kind: "git", view: { commit: "Keep the original draft" } })
    await source.flush()
    const id = source.state.tabs[0]!.id
    const sourceBucket = `panels-${encodeDir(`new:${directory}`)}`
    const set = persistent.set
    const remove = persistent.remove
    const entries = persistent.entries
    vi.spyOn(persistent, "entries").mockImplementation(async (bucket) => {
      if (stage === "initial flush" && bucket === "panel-transfers") throw new Error("Storage unavailable")
      return entries(bucket)
    })
    vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
      if (
        (stage === "journal" && args[0] === "panel-transfers") ||
        (stage === "destination" && args[0] === `panels-${encodeDir(target.sessionID)}`) ||
        (stage === "source cleanup" && args[0] === sourceBucket && JSON.parse(args[2]).tabs.length === 0)
      )
        throw new Error("Storage unavailable")
      await set(...args)
    })
    vi.spyOn(persistent, "remove").mockImplementation(async (...args) => {
      if (stage === "journal cleanup" && args[0] === "panel-transfers") throw new Error("Storage unavailable")
      await remove(...args)
    })
    const promotion = workspace.promotePanels(directory, target)
    const opening = workspace.openPanel({ kind: "terminal" }, true)
    await expect(promotion).rejects.toThrow()
    await expect(opening).rejects.toThrow()
    vi.restoreAllMocks()
    const retry = workspace.promotePanels(directory, target)
    const reopened = workspace.openPanel({ kind: "terminal" }, true)
    await Promise.all([retry, reopened])
    const created = await workspace.selectPanels(target)
    expect(created.state.tabs).toMatchObject([
      { id, kind: "git", view: { commit: "Keep the original draft" } },
      { kind: "terminal", ptyDirectory: directory },
    ])
    const terminalID = created.state.tabs[1]!.id
    await workspace.openPanel({ kind: "terminal" }, true)
    expect(created.state.tabs).toHaveLength(2)
    await workspace.flushPanels()
    vi.resetModules()
    const restarted = await load()
    expect((await restarted.selectPanels(target)).state.tabs.map((tab) => tab.id)).toEqual([id, terminalID])
    expect((await restarted.selectPanels({ directory })).state.tabs).toEqual([])
  },
)

test.each([false, true])("a new open can retry failed migration after a background flush: %s", async (flush) => {
  const workspace = await load()
  const { persistent } = await import("../../lib/persistence")
  const directory = "/open-after-recovery"
  const target = { directory, sessionID: await chat() }
  await workspace.selectPanels({ directory })
  await workspace.openPanel({ kind: "git", view: { commit: "Keep after recovery" } })
  const set = persistent.set
  const storage = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
    if (args[0] === "panel-transfers") throw new Error("Storage unavailable")
    await set(...args)
  })
  const promotion = workspace.promotePanels(directory, target)
  const opening = workspace.openPanel({ kind: "terminal" }, true)
  await expect(promotion).rejects.toThrow("Storage unavailable")
  await expect(opening).rejects.toThrow("Storage unavailable")
  storage.mockRestore()
  if (flush) await workspace.flushPanels()
  await workspace.openPanel({ kind: "terminal" }, true)
  await workspace.openPanel({ kind: "terminal" }, true)
  expect((await workspace.selectPanels(target)).state.tabs).toMatchObject([
    { kind: "git", view: { commit: "Keep after recovery" } },
    { kind: "terminal", ptyDirectory: directory },
  ])
  expect((await workspace.selectPanels({ directory })).state.tabs).toEqual([])
})

for (const stage of ["destination", "startup event", "owner registration", "journal cleanup"])
  test(`navigation after failed ${stage} survives migration recovery and a second restart`, async () => {
    const before = await load()
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const directory = `/browser-recovery-${stage}`
    const target = { directory, sessionID: await chat() }
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
      await load()
    }
    events.state(browserState(id, "https://example.invalid/final", "Final"))
    const owner = stage === "destination" || stage === "startup event" ? `new:${directory}` : target.sessionID
    await vi.waitFor(async () =>
      expect(JSON.parse((await persistent.get(`panels-${encodeDir(owner)}`, "layout"))!).tabs[0].url).toBe(
        "https://example.invalid/final",
      ),
    )
    vi.restoreAllMocks()
    vi.resetModules()
    const after = await load()
    const restored = await after.selectPanels(target)
    expect(restored.state.tabs).toMatchObject([
      { id, kind: "browser", url: "https://example.invalid/final", title: "Final" },
    ])
    expect((await after.selectPanels({ directory })).state.tabs).toEqual([])
    expect(await (await import("../../lib/persistence")).persistent.entries("panel-transfers")).toEqual([])
    vi.resetModules()
    expect((await (await load()).selectPanels(target)).state.tabs).toEqual(restored.state.tabs)
  })

test("a late legacy draft migration preserves a newer durable edit", async () => {
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const { readDraft, writeDraft } = await import("../code/draft")
  const directory = await folder("strict-audit-race")
  const bucket = "draft-" + encodeDir(directory)
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  await persistent.set(
    bucket,
    "src/../notes.txt",
    JSON.stringify({
      version: 1,
      content: "Old draft",
      saved: "Original file",
    }),
  )
  await load()
  const read = persistent.entries
  let visits = 0
  const spy = vi.spyOn(persistent, "entries").mockImplementation(async (key) => {
    const snapshot = await read(key)
    if (key === bucket && ++visits === 2) {
      entered.resolve()
      await gate.promise
    }
    return snapshot
  })
  const restoring = readDraft(directory, "notes.txt")
  try {
    await entered.promise
    await writeDraft(directory, "notes.txt", { content: "New user draft", saved: "Original file" })
    expect(JSON.parse((await persistent.get(bucket, "notes.txt"))!).content).toBe("New user draft")
    expect(await persistent.get(bucket, "src/../notes.txt")).toBeNull()
    gate.resolve()
    await restoring
    vi.resetModules()
    const restarted = await import("../code/draft")
    expect((await restarted.readDraft(directory, "notes.txt"))?.content).toBe("New user draft")
  } finally {
    gate.resolve()
    await restoring
    spy.mockRestore()
  }
})

test("cancellation recovery cannot replace a newer draft in another chat", async () => {
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const { flushDrafts } = await import("../code/draft")
  const { buffersFor } = await import("../code/state")
  const directory = await folder("strict-audit-cancel-race")
  const source = "new:" + directory
  const bucket = "draft-" + encodeDir(directory)
  const snapshot = {
    version: 1,
    directory,
    tabs: [
      { id: "file", kind: "file", path: "notes.txt", fileDirectory: directory },
      { id: "browser", kind: "browser", url: "https://example.invalid/closing" },
    ],
  }
  await persistent.set("panels-" + encodeDir(source), "layout", JSON.stringify(snapshot))
  await persistent.set("file-links-" + encodeDir(directory), "notes.txt", JSON.stringify([source]))
  await persistent.set(
    bucket,
    "src/../notes.txt",
    JSON.stringify({
      version: 1,
      content: "Old draft",
      saved: "Original content",
    }),
  )
  await persistent.set(
    "panel-transfers",
    "deleted-racing",
    JSON.stringify({
      version: 1,
      sourceContext: { directory },
      target: { directory, sessionID: "deleted-racing" },
      snapshot,
      cancelled: true,
    }),
  )
  const workspace = await load()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  let closed = false
  let visits = 0
  events.close = async () => {
    closed = true
    return true
  }
  events.entries = async (key) => {
    if (closed && key === bucket && ++visits === 2) {
      entered.resolve()
      await gate.promise
    }
  }
  try {
    await workspace.selectPanels({ directory, sessionID: "healthy-editor" })
    await entered.promise
    await workspace.openPanel({ kind: "file", path: "notes.txt" })
    const buffer = buffersFor(directory)
    await buffer.open("notes.txt")
    buffer.tabs[0]!.model!.setValue("Keep this new user draft")
    await flushDrafts()
    expect(JSON.parse((await persistent.get(bucket, "notes.txt"))!).content).toBe("Keep this new user draft")
    gate.resolve()
    await vi.waitFor(async () => expect(await persistent.entries("panel-transfers")).toEqual([]))
    vi.resetModules()
    const restarted = await import("../code/draft")
    expect((await restarted.readDraft(directory, "notes.txt"))?.content).toBe("Keep this new user draft")
  } finally {
    gate.resolve()
  }
})

test.each(["selection", "deletion"])("a pending migration %s must not hold a later healthy chat", async (operation) => {
  const before = await load()
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const directory = await folder("migration-await")
  const target = { directory, sessionID: await chat() }
  const source = await before.selectPanels({ directory })
  await before.openPanel({ kind: "file", path: "notes.txt" })
  await source.flush()
  const set = persistent.set
  const failure = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
    if (args[0] === "panels-" + encodeDir(target.sessionID)) throw new Error("Destination unavailable")
    await set(...args)
  })
  await expect(before.promotePanels(directory, target)).rejects.toThrow("Destination unavailable")
  failure.mockRestore()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  hooks.identity = async (path) => {
    if (path !== "notes.txt") return
    entered.resolve()
    await release.promise
  }
  vi.resetModules()
  const after = await load()
  const loading = operation === "selection" ? after.selectPanels(target) : after.releasePanels(target, true)
  let healthy: Promise<unknown> | undefined
  try {
    await Promise.race([
      entered.promise,
      loading.then(() => {
        throw new Error("Identity gate not reached")
      }),
    ])
    let ready = false
    healthy = after.selectPanels({ directory: "/healthy-await", sessionID: "healthy-await" }).then(() => {
      ready = true
    })
    await vi.waitFor(() => expect(ready).toBe(true), { timeout: 500, interval: 20 })
    await after.openPanel({ kind: "browser", url: "https://example.invalid/old" })
    const browser = after.panels()!.state.tabs[0]!
    events.state(browserState(browser.id, "https://example.invalid/final", "Final"))
    await after.flushPanels()
    expect(JSON.parse((await persistent.get("panels-" + encodeDir("healthy-await"), "layout"))!).tabs[0].url).toBe(
      "https://example.invalid/final",
    )
  } finally {
    release.resolve()
    await Promise.allSettled([loading, healthy])
    await after.openPanel({ kind: "git", view: { commit: "Healthy after releasing old recovery" } })
    expect(after.panels()?.state.tabs.find((tab) => tab.kind === "git")?.view?.commit).toBe(
      "Healthy after releasing old recovery",
    )
  }
})

test("shutdown waits for an accepted file open without waiting for unrelated recovery", async () => {
  const workspace = await load()
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const target = { directory: await folder("open-before-exit"), sessionID: "open-before-exit" }
  await workspace.selectPanels(target)
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  hooks.identity = async () => {
    entered.resolve()
    await gate.promise
  }
  const opening = workspace.openPanel({ kind: "file", path: "notes.txt" })
  await entered.promise
  let flushed = false
  const flushing = workspace.flushPanels().then(() => {
    flushed = true
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(flushed).toBe(false)
  } finally {
    gate.resolve()
    await Promise.all([opening, flushing])
  }
  expect(JSON.parse((await persistent.get("panels-" + encodeDir(target.sessionID), "layout"))!).tabs).toEqual([
    expect.objectContaining({ kind: "file", path: "notes.txt" }),
  ])
})

test("a malformed journal belonging to another chat must not block selection", async () => {
  const { persistent } = await import("../../lib/persistence")
  const workspace = await load()
  const raw = '{"version":1,"target":{"directory":"/offline","sessionID":"invalid-old-target"}'
  await persistent.set("panel-transfers", "invalid-old-target", raw)
  const healthy = { directory: "/healthy", sessionID: "healthy-new" }
  const first = await workspace.selectPanels(healthy).catch((error) => error)
  await expect(
    workspace.selectPanels({ directory: "/offline", sessionID: "invalid-old-target" }),
  ).rejects.toMatchObject({ code: "MRK-4026" })
  await expect(
    workspace.releasePanels({ directory: "/offline", sessionID: "invalid-old-target" }, true),
  ).rejects.toMatchObject({ code: "MRK-4026" })
  await workspace.selectPanels(healthy)
  await workspace.openPanel({ kind: "git", view: { commit: "Keep healthy edits" } })
  await workspace.flushPanels()
  expect(await persistent.get("panel-transfers", "invalid-old-target")).toBe(raw)
  await persistent.remove("panel-transfers", "invalid-old-target")
  expect((await workspace.selectPanels(healthy)).state.tabs[0]?.view?.commit).toBe("Keep healthy edits")
  expect(first).not.toBeInstanceOf(Error)
})

test("late browser journal cannot survive successful promotion and resurrect a closed tab", async () => {
  const workspace = await load()
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const { releaseBrowserState } = await import("../browser/state")
  const directory = "/late-browser-journal-probe"
  const target = { directory, sessionID: await chat() }
  const source = await workspace.selectPanels({ directory })
  await workspace.openPanel({ kind: "browser", url: "https://example.invalid/old" })
  const id = source.state.tabs[0]!.id
  const entered = Promise.withResolvers<void>()
  const releaseDestination = Promise.withResolvers<void>()
  const journalEntered = Promise.withResolvers<void>()
  const releaseJournal = Promise.withResolvers<void>()
  const set = persistent.set
  let firstDestination = true
  const delay = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
    if (args[0] === "panels-" + encodeDir(target.sessionID) && firstDestination) {
      firstDestination = false
      entered.resolve()
      await releaseDestination.promise
    }
    if (args[0] === "panel-transfers" && args[2].includes("/final")) {
      journalEntered.resolve()
      await releaseJournal.promise
    }
    return set(...args)
  })
  let promotion: Promise<void> | undefined
  try {
    promotion = workspace.promotePanels(directory, target)
    await entered.promise
    events.state(browserState(id, "https://example.invalid/final", "Final"))
    await journalEntered.promise
    releaseDestination.resolve()
    let promoted = false
    void promotion.then(() => {
      promoted = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(promoted).toBe(false)
    releaseJournal.resolve()
    await promotion
    expect(await persistent.get("panel-transfers", target.sessionID)).toBeNull()
    const destination = await workspace.selectPanels(target)
    await releaseBrowserState(id)
    await destination.remove(id)
    releaseJournal.resolve()
    await workspace.flushPanels()
    vi.resetModules()
    const after = await load()
    const reopened = await after.selectPanels(target)
    expect(reopened.state.tabs).toEqual([])
  } finally {
    releaseDestination.resolve()
    releaseJournal.resolve()
    await promotion
    delay.mockRestore()
  }
})

test("a deleted target cancels recovery already waiting for file identity", async () => {
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const directory = await folder("cancel-overlapping-recovery")
  const target = { directory, sessionID: await chat() }
  const workspace = await load()
  const snapshot = {
    version: 1,
    tabs: [
      { id: "file-overlap", kind: "file", path: "notes.txt", fileDirectory: directory },
      { id: "browser-overlap", kind: "browser", url: "https://example.invalid/old" },
    ],
  }
  await persistent.set("panels-" + encodeDir("new:" + directory), "layout", JSON.stringify(snapshot))
  await persistent.set(
    "panel-transfers",
    target.sessionID,
    JSON.stringify({ version: 1, sourceContext: { directory }, target, snapshot }),
  )
  const lookupEntered = Promise.withResolvers<void>()
  const releaseLookup = Promise.withResolvers<void>()
  const identityEntered = Promise.withResolvers<void>()
  const releaseIdentity = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  let first = true
  hooks.lookup = async () => {
    if (!first) return
    first = false
    lookupEntered.resolve()
    await releaseLookup.promise
  }
  hooks.identity = async () => {
    identityEntered.resolve()
    await releaseIdentity.promise
  }
  events.close = async () => {
    closed.resolve()
    return true
  }
  let selecting: Promise<unknown> | undefined
  try {
    await workspace.selectPanels({ directory: "/healthy-overlap", sessionID: "healthy-overlap" })
    await lookupEntered.promise
    selecting = workspace.selectPanels(target)
    await identityEntered.promise
    await engine.session.delete({ session: target.sessionID })
    releaseLookup.resolve()
    await vi.waitFor(async () =>
      expect(JSON.parse((await persistent.get("panel-transfers", target.sessionID))!).cancelled).toBe(true),
    )
    releaseIdentity.resolve()
    await selecting
    await closed.promise
    await workspace.flushPanels()
    await vi.waitFor(async () => expect(await persistent.get("panel-transfers", target.sessionID)).toBeNull())
    expect(JSON.parse((await persistent.get("panels-" + encodeDir(target.sessionID), "layout"))!).tabs).toEqual([])
  } finally {
    releaseLookup.resolve()
    releaseIdentity.resolve()
    await selecting
  }
})

test("cancellation write failure after journal removal remains recoverable on shutdown", async () => {
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const workspace = await load()
  const directory = "/cancel-removal-failure"
  const target = { directory, sessionID: await chat() }
  const snapshot = { version: 1, tabs: [{ id: "browser", kind: "browser", url: "https://example.invalid/old" }] }
  await persistent.set("panels-" + encodeDir("new:" + directory), "layout", JSON.stringify(snapshot))
  await persistent.set(
    "panel-transfers",
    target.sessionID,
    JSON.stringify({ version: 1, sourceContext: { directory }, target, snapshot }),
  )
  const lookupEntered = Promise.withResolvers<void>()
  const releaseLookup = Promise.withResolvers<void>()
  const removalEntered = Promise.withResolvers<void>()
  const releaseRemoval = Promise.withResolvers<void>()
  const listed = Promise.withResolvers<void>()
  let first = true
  hooks.lookup = async () => {
    if (!first) return
    first = false
    lookupEntered.resolve()
    await releaseLookup.promise
    return listed.resolve
  }
  const remove = persistent.remove
  const removing = vi.spyOn(persistent, "remove").mockImplementation(async (...args) => {
    if (args[0] === "panel-transfers") {
      removalEntered.resolve()
      await releaseRemoval.promise
    }
    return remove(...args)
  })
  const set = persistent.set
  let failed = false
  let unavailable = true
  const writing = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
    if (args[0] === "panel-transfers" && JSON.parse(args[2]).cancelled && unavailable) {
      failed = true
      throw new Error("Cancellation record failed")
    }
    return set(...args)
  })
  let selecting: Promise<unknown> | undefined
  try {
    await workspace.selectPanels({ directory: "/healthy-removal", sessionID: "healthy-removal" })
    await lookupEntered.promise
    selecting = workspace.selectPanels(target)
    const handled = selecting.catch((error) => error)
    await removalEntered.promise
    await engine.session.delete({ session: target.sessionID })
    releaseLookup.resolve()
    // The deleted conversation is seen by the held lookup; let the cancellation start before the removal finishes.
    await listed.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseRemoval.resolve()
    expect(await handled).toBeInstanceOf(Error)
    expect(failed).toBe(true)
    await expect(workspace.flushPanels()).rejects.toThrow("Cancellation record failed")
    unavailable = false
    await workspace.flushPanels()
    expect(JSON.parse((await persistent.get("panel-transfers", target.sessionID))!).cancelled).toBe(true)
  } finally {
    releaseLookup.resolve()
    releaseRemoval.resolve()
    await selecting?.catch(() => {})
    removing.mockRestore()
    writing.mockRestore()
  }
})
