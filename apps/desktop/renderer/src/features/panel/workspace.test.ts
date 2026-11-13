import { execFile } from "node:child_process"
import { mkdir, rename, symlink } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { fileOwners } from "../code/references"
import { openPanel, panels, promotePanels, releasePanels, selectPanels } from "./workspace"
import { persistent } from "../../lib/persistence"
import { encodeDir } from "../../lib/route"
import { refreshBranches, switchReason, unsavedReason } from "../../state/git"
import { readDraft, writeDraft } from "../code/draft"

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
            listeners.forEach((listener) => listener())
          },
          onDidChangeContent: (listener: () => void) => listeners.push(listener),
          dispose() {},
        }
      },
    },
  },
}))

// The Go engine answers every request for real. The hook only holds a file identity lookup of one folder before it
// is forwarded, because the engine cannot be told to stall.
const held = new Map<string, { entered: () => void; release: Promise<void> }>()
let env: Awaited<ReturnType<typeof engineFixture>>
let engine: Awaited<ReturnType<typeof client>>
let counter = 0
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
  engine = await client()
  const identity = engine.file.identity.bind(engine.file)
  engine.file.identity = (async (...args: Parameters<typeof identity>) => {
    const hold = held.get(args[0].directory ?? "")
    hold?.entered()
    await hold?.release
    return identity(...args)
  }) as typeof identity
}, 120_000)
afterAll(async () => {
  try {
    await engine.close()
  } finally {
    await env?.close()
  }
})
afterEach(() => {
  held.clear()
})

const fresh = (name: string) => path.join(path.dirname(env.project), `${name}-${++counter}`)
/** A real folder, named the way the engine names it. */
async function folder(name: string) {
  const directory = fresh(name)
  await mkdir(directory)
  return (await engine.file.identity({ directory, path: "." })).directory
}
/** A real checkout with a commit, so that its branch can be switched. */
async function checkout(name: string) {
  const directory = await folder(name)
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: directory, windowsHide: true })
  await git("init", "-b", "main")
  await git("config", "user.name", "Fixture")
  await git("config", "user.email", "fixture@example.invalid")
  await git("commit", "--allow-empty", "-m", "initial")
  return directory
}
const offline = (directory: string) => rename(directory, `${directory}.away`)
const online = (directory: string) => rename(`${directory}.away`, directory)
/** A conversation the engine really knows; an unknown id stands for a deleted one. */
const chat = async () =>
  (await engine.session.create({ provider: "fake", model: "test", workdir: env.project })).session

test.each([
  { id: "bad-directory", kind: "file", path: "notes.txt", fileDirectory: 123 },
  { id: "bad-path", kind: "file", path: 123 },
  null,
])("invalid saved file descriptors do not prevent valid tabs from restoring: %j", async (invalid) => {
  const directory = await folder("valid-layout")
  const sessionID = crypto.randomUUID()
  const bucket = `panels-${encodeDir(sessionID)}`
  await persistent.set(
    bucket,
    "layout",
    JSON.stringify({
      version: 1,
      selected: "browser",
      tabs: [
        { id: "browser", kind: "browser", url: "https://example.com" },
        invalid,
        { id: "file", kind: "file", path: "src/../notes.txt" },
        { id: "alias", kind: "file", path: "notes.txt" },
      ],
    }),
  )
  const restored = await selectPanels({ directory, sessionID })
  expect(restored.state.tabs.map((tab) => tab.id)).toEqual(["browser", "file"])
  expect(restored.state.tabs[1]).toMatchObject({ fileDirectory: directory, path: "notes.txt" })
  expect(restored.state.selected).toBe("browser")
  await restored.flush()
  expect(JSON.parse((await persistent.get(bucket, "layout"))!).tabs).toEqual(restored.state.tabs)
})

test("an unconfirmed offline alias retains its draft and restores protection after reconnecting", async () => {
  const root = await checkout("draft-lookup-root")
  const directory = fresh("draft-lookup-sibling")
  const bucket = `draft-${encodeDir(directory)}`
  const raw = JSON.stringify({ version: 1, content: "keep draft", saved: "original" })
  await persistent.set(bucket, "notes.txt", raw)
  expect(await refreshBranches(root)).toMatchObject({ directory: root })
  expect(switchReason(root)).toBeUndefined()
  expect(await persistent.get(bucket, "notes.txt")).toBe(raw)
  await symlink(root, directory, "junction")
  expect(await refreshBranches(root)).toMatchObject({ directory: root })
  expect(unsavedReason(root)).toBeTruthy()
})

test("empty historical draft buckets do not block checkout when their directory is unavailable", async () => {
  const root = await checkout("empty-draft-current")
  const orphan = fresh("empty-draft-unavailable")
  const buckets = persistent.buckets.bind(persistent)
  const storage = vi
    .spyOn(persistent, "buckets")
    .mockImplementation(async () => [...(await buckets()), `draft-${encodeDir(orphan)}`])
  try {
    expect(await refreshBranches(root)).toMatchObject({ directory: root })
    expect(switchReason(root)).toBeUndefined()
  } finally {
    storage.mockRestore()
  }
})

test("a failed directory lookup leaves a legacy file layout untouched until a successful retry", async () => {
  const directory = await folder("retry-root")
  const sessionID = crypto.randomUUID()
  const bucket = `panels-${encodeDir(sessionID)}`
  const raw = JSON.stringify({
    version: 1,
    tabs: [{ id: "file", kind: "file", fileDirectory: directory, path: "notes.txt" }],
  })
  await persistent.set(bucket, "layout", raw)
  await offline(directory)
  await expect(selectPanels({ directory, sessionID })).rejects.toThrow()
  expect(await persistent.get(bucket, "layout")).toBe(raw)
  await online(directory)
  const restored = await selectPanels({ directory, sessionID })
  expect(restored.state.tabs[0]).toMatchObject({ fileDirectory: directory, path: "notes.txt" })
})

test("selecting a legacy conversation durably merges singleton tabs before exposing it", async () => {
  const sessionID = crypto.randomUUID()
  const bucket = `panels-${encodeDir(sessionID)}`
  await persistent.set(
    bucket,
    "layout",
    JSON.stringify({
      version: 1,
      selected: "b",
      tabs: [
        { id: "a", kind: "git", view: { commit: "first" } },
        { id: "b", kind: "git", view: { commit: "second" } },
      ],
    }),
  )
  const restored = await selectPanels({ directory: "/legacy-ui", sessionID })
  expect(restored.state.tabs).toHaveLength(1)
  expect(restored.state.selected).toBe("b")
  expect(JSON.parse((await persistent.get(bucket, "layout"))!).tabs).toEqual(restored.state.tabs)
  expect(restored.view("b")).toMatchObject({ commit: "second", commitAlternatives: ["first"] })
})

test("visiting an existing conversation never adopts the new-conversation editor", async () => {
  const directory = `/workspace/${crypto.randomUUID()}`
  const draft = await selectPanels({ directory })
  await openPanel({ kind: "git", view: { commit: "keep my draft" } })
  const id = draft.state.tabs[0]!.id
  const old = await selectPanels({ directory, sessionID: crypto.randomUUID() })
  expect(old.state.tabs).toEqual([])
  expect(await selectPanels({ directory })).toBe(draft)
  expect(panels()?.state.tabs[0]?.id).toBe(id)
  expect(panels()?.view(id).commit).toBe("keep my draft")
})

test("first submission moves tab identity and file ownership into the actual worktree conversation", async () => {
  const directory = await folder("workspace")
  const target = { directory: await folder("workspace-worktree"), sessionID: await chat() }
  const draft = await selectPanels({ directory })
  await openPanel({ kind: "file", path: `${directory}/src/app.ts`, view: { dirty: true } })
  await openPanel({ kind: "git", view: { commit: "preserve this too" } })
  const ids = draft.state.tabs.map((tab) => tab.id)
  await promotePanels(directory, target)
  const created = await selectPanels(target)
  expect(created.state.tabs.map((tab) => tab.id)).toEqual(ids)
  expect(created.state.selected).toBe(ids[1])
  expect(created.state.tabs[0]).toMatchObject({ fileDirectory: directory, path: "src/app.ts", view: { dirty: true } })
  expect(await fileOwners(directory, "src/app.ts")).toEqual([target.sessionID])
  await openPanel({ kind: "file", fileDirectory: directory, path: "src/app.ts" })
  expect(created.state.tabs).toHaveLength(2)
  await openPanel({ kind: "file", path: "src/app.ts" })
  expect(created.state.tabs).toHaveLength(3)
  expect(created.state.tabs[2]?.fileDirectory).toBe(target.directory)
  expect((await selectPanels({ directory })).state.tabs).toEqual([])
})

test("promotion waits for an accepted close before capturing the transferred tabs", async () => {
  const directory = `/workspace/${crypto.randomUUID()}`
  const draft = await selectPanels({ directory })
  await openPanel({ kind: "git" })
  const id = draft.state.tabs[0]!.id
  const finish = draft.beginClose()
  const target = { directory, sessionID: await chat() }
  const transfer = promotePanels(directory, target)
  await Promise.resolve()
  await draft.remove(id)
  finish()
  await transfer
  expect((await selectPanels(target)).state.tabs).toEqual([])
})

test("first submission preserves a file opened while its identity response is pending", async () => {
  const directory = await folder("workspace")
  const target = { directory: await folder("workspace-worktree"), sessionID: await chat() }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  held.set(directory, { entered: entered.resolve, release: release.promise })
  await selectPanels({ directory })
  const opening = openPanel({ kind: "file", path: "notes.txt" })
  await entered.promise
  const promotion = promotePanels(directory, target)
  try {
    // Release the network response even when submission correctly waits for the accepted open.
    await Promise.race([promotion, new Promise((resolve) => setTimeout(resolve, 100))])
  } finally {
    release.resolve()
  }
  await Promise.all([opening, promotion])
  const created = await selectPanels(target)
  expect(created.state.tabs).toHaveLength(1)
  expect(created.state.tabs[0]).toMatchObject({ kind: "file", fileDirectory: directory, path: "notes.txt" })
  expect(await fileOwners(directory, "notes.txt")).toEqual([target.sessionID])
  expect((await selectPanels({ directory })).state.tabs).toEqual([])
})

test("a delayed file open stays in its originating conversation when another conversation is selected", async () => {
  const directory = await folder("workspace")
  const origin = { directory, sessionID: crypto.randomUUID() }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  held.set(directory, { entered: entered.resolve, release: release.promise })
  await selectPanels(origin)
  const opening = openPanel({ kind: "file", path: "notes.txt" })
  await entered.promise
  const switching = selectPanels({ directory, sessionID: crypto.randomUUID() })
  release.resolve()
  await opening
  expect((await switching).state.tabs).toEqual([])
  const restored = await selectPanels(origin)
  expect(restored.state.tabs).toHaveLength(1)
  expect(restored.state.tabs[0]).toMatchObject({ kind: "file", path: "notes.txt" })
  expect(await fileOwners(directory, "notes.txt")).toEqual([origin.sessionID])
})

test("a failed file open can be retried without blocking subsequent conversation operations", async () => {
  const directory = await folder("workspace")
  const origin = { directory, sessionID: crypto.randomUUID() }
  const state = await selectPanels(origin)
  await offline(directory)
  await expect(openPanel({ kind: "file", path: "notes.txt" })).rejects.toThrow()
  expect(state.state.tabs).toEqual([])
  expect((await selectPanels({ directory, sessionID: crypto.randomUUID() })).state.tabs).toEqual([])
  await online(directory)
  await selectPanels(origin)
  await openPanel({ kind: "file", path: "notes.txt" })
  expect(state.state.tabs).toHaveLength(1)
  expect(state.state.tabs[0]).toMatchObject({ kind: "file", path: "notes.txt" })
})

test("an open accepted during first submission follows the original conversation into its worktree", async () => {
  const directory = `/workspace/${crypto.randomUUID()}`
  const target = { directory: `${directory}-worktree`, sessionID: await chat() }
  const source = await selectPanels({ directory })
  await openPanel({ kind: "git", view: { commit: "Keep this draft" } })
  const finish = source.beginClose()
  const promotion = promotePanels(directory, target)
  try {
    await vi.waitFor(() => expect(source.state.transferring).toBe(true))
    const opening = openPanel({ kind: "terminal" }, true)
    const other = selectPanels({ directory, sessionID: crypto.randomUUID() })
    finish()
    await Promise.all([promotion, opening])
    expect((await other).state.tabs).toEqual([])
    const created = await selectPanels(target)
    expect(created.state.tabs).toMatchObject([
      { kind: "git", view: { commit: "Keep this draft" } },
      { kind: "terminal", ptyDirectory: directory },
    ])
    expect(created.state.selected).toBe(created.state.tabs[1]!.id)
    expect((await selectPanels({ directory })).state.tabs).toEqual([])
  } finally {
    if (source.state.transferring) finish()
  }
})

test.each(["queued", "flushing", "complete"])(
  "opens after a %s promotion retain their chat and directory",
  async (stage) => {
    const directory = await folder("workspace")
    const target = { directory: await folder("workspace-worktree"), sessionID: await chat() }
    const source = await selectPanels({ directory })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const entries = persistent.entries
    const storage = vi.spyOn(persistent, "entries").mockImplementation(async (bucket) => {
      if (stage === "flushing" && bucket === "panel-transfers") {
        entered.resolve()
        await release.promise
      }
      return entries(bucket)
    })
    try {
      const promotion = promotePanels(directory, target)
      if (stage === "flushing") {
        await entered.promise
        expect(source.state.transferring).toBe(false)
      }
      if (stage === "complete") await promotion
      const opening = Promise.all([
        openPanel({ kind: "terminal" }),
        openPanel({ kind: "file", path: "notes.txt" }),
        openPanel({ kind: "browser", url: "https://example.invalid/accepted" }),
        openPanel({ kind: "review", view: { scope: "turn", messageID: "original-round" } }),
        openPanel({ kind: "git", view: { commit: "Accepted during promotion" } }),
      ])
      const other = selectPanels({ directory, sessionID: crypto.randomUUID() })
      release.resolve()
      await Promise.all([promotion, opening])
      expect((await other).state.tabs).toEqual([])
      const created = await selectPanels(target)
      expect(created.state.tabs).toMatchObject([
        { kind: "terminal", ptyDirectory: directory },
        { kind: "file", path: "notes.txt", fileDirectory: directory },
        { kind: "browser", url: "https://example.invalid/accepted" },
        { kind: "review", view: { scope: "turn", messageID: "original-round" } },
        { kind: "git", view: { commit: "Accepted during promotion" } },
      ])
      expect(await fileOwners(directory, "notes.txt")).toEqual([target.sessionID])
      expect(JSON.parse((await persistent.get("browser-owners", created.state.tabs[2]!.id))!)).toEqual(target)
      expect((await selectPanels({ directory })).state.tabs).toEqual([])
      await selectPanels(target)
      await openPanel({ kind: "terminal", ptyDirectory: directory }, true)
      await openPanel({ kind: "file", fileDirectory: directory, path: "notes.txt" })
      expect(created.state.tabs).toHaveLength(5)
    } finally {
      release.resolve()
      storage.mockRestore()
    }
  },
)

test("an open queued after its originating conversation is deleted reports failure", async () => {
  const origin = { directory: `/workspace/${crypto.randomUUID()}`, sessionID: crypto.randomUUID() }
  await selectPanels(origin)
  const removing = releasePanels(origin, true)
  const opening = openPanel({ kind: "terminal" })
  await removing
  await expect(opening).rejects.toThrow("MRK-4025")
  expect((await selectPanels({ directory: origin.directory, sessionID: crypto.randomUUID() })).state.tabs).toEqual([])
})

test("an open cannot recreate a deleted promotion target while the draft route is still selected", async () => {
  const directory = `/workspace/${crypto.randomUUID()}`
  const target = { directory, sessionID: await chat() }
  await selectPanels({ directory })
  const promotion = promotePanels(directory, target)
  const removing = releasePanels(target, true)
  const opening = openPanel({ kind: "terminal" })
  const result = expect(opening).rejects.toThrow("MRK-4025")
  await Promise.all([promotion, removing, result])
  expect(JSON.parse((await persistent.get(`panels-${encodeDir(target.sessionID)}`, "layout"))!).tabs).toEqual([])
})

test("cancelling a failed transfer releases both owners and preserves only shared file drafts", async () => {
  const directory = await folder("workspace")
  const sibling = { directory, sessionID: crypto.randomUUID() }
  const target = { directory, sessionID: await chat() }
  await selectPanels(sibling)
  await openPanel({ kind: "file", path: "shared.txt" })
  await selectPanels({ directory })
  await openPanel({ kind: "file", path: "shared.txt" })
  await openPanel({ kind: "file", path: "private.txt" })
  await writeDraft(directory, "shared.txt", { saved: "original", content: "Shared edits" })
  await writeDraft(directory, "private.txt", { saved: "original", content: "Discard with deleted chat" })
  const sourceBucket = `panels-${encodeDir(`new:${directory}`)}`
  const set = persistent.set
  const failure = vi.spyOn(persistent, "set").mockImplementation(async (...args) => {
    if (args[0] === sourceBucket && JSON.parse(args[2]).tabs.length === 0) throw new Error("Cleanup unavailable")
    await set(...args)
  })
  try {
    await expect(promotePanels(directory, target)).rejects.toThrow("Cleanup unavailable")
  } finally {
    failure.mockRestore()
  }
  await releasePanels(target, true)
  expect(await fileOwners(directory, "shared.txt")).toEqual([sibling.sessionID])
  expect(await readDraft(directory, "shared.txt")).toMatchObject({ content: "Shared edits" })
  expect(await fileOwners(directory, "private.txt")).toEqual([])
  expect(await readDraft(directory, "private.txt")).toBeUndefined()
  expect((await selectPanels(sibling)).state.tabs).toMatchObject([{ kind: "file", path: "shared.txt" }])
  await releasePanels(target, true)
  expect(await readDraft(directory, "shared.txt")).toMatchObject({ content: "Shared edits" })
})

test("a file open that finishes late does not take the selection from the tab the person picked meanwhile", async () => {
  const directory = await folder("workspace")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await selectPanels({ directory })
  await openPanel({ kind: "git" })
  const opened = await selectPanels({ directory })
  const git = opened.state.tabs.find((tab) => tab.kind === "git")!
  held.set(directory, { entered: entered.resolve, release: release.promise })
  const opening = openPanel({ kind: "file", path: "notes.txt" })
  await entered.promise
  opened.activate(git.id)
  release.resolve()
  await opening
  expect(opened.state.tabs.map((tab) => tab.kind).sort()).toEqual(["file", "git"])
  expect(opened.state.selected).toBe(git.id)
})

test("a file open with no other choice made meanwhile selects its tab", async () => {
  const directory = await folder("workspace")
  await selectPanels({ directory })
  await openPanel({ kind: "git" })
  await openPanel({ kind: "file", path: "notes.txt" })
  const opened = await selectPanels({ directory })
  const file = opened.state.tabs.find((tab) => tab.kind === "file")!
  expect(opened.state.selected).toBe(file.id)
})
