import { expect, test, vi } from "vitest"
import { fileOwners } from "../code/references"
import { openPanel, panels, promotePanels, selectPanels } from "./workspace"
import { persistent } from "../../lib/persistence"
import { encodeDir } from "../../lib/route"
import { refreshBranches, switchReason, unsavedReason } from "../../state/git"

const directoryReplies = new Map<string, { root: string; fail?: boolean }>()
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (_input: string, init?: { headers?: HeadersInit }) => {
    const directory = decodeURIComponent(new Headers(init?.headers).get("x-merakcode-directory")!)
    const reply = directoryReplies.get(directory)
    if (reply?.fail) {
      reply.fail = false
      return new Response("unavailable", { status: 503 })
    }
    return new Response(JSON.stringify({ directory: reply?.root ?? directory, branches: [], current: null }), {
      headers: { "content-type": "application/json" },
    })
  },
}))

test("branch controls stay blocked when a sleeping subdirectory draft cannot be resolved", async () => {
  const root = "/draft-lookup-root"
  const directory = `${root}/sub`
  const bucket = `draft-${encodeDir(directory)}`
  const raw = JSON.stringify({ version: 1, content: "keep draft", saved: "original" })
  await persistent.set(bucket, "notes.txt", raw)
  directoryReplies.set(directory, { root, fail: true })
  expect(await refreshBranches(root)).toBeUndefined()
  expect(switchReason(root)).toBeTruthy()
  expect(await persistent.get(bucket, "notes.txt")).toBe(raw)
  expect(await refreshBranches(root)).toMatchObject({ directory: root })
  expect(unsavedReason(root)).toBeTruthy()
})

test("a failed directory lookup leaves a legacy file layout untouched until a successful retry", async () => {
  const directory = "/retry-root/sub"
  const sessionID = crypto.randomUUID()
  const bucket = `panels-${encodeDir(sessionID)}`
  const raw = JSON.stringify({
    version: 1,
    tabs: [{ id: "file", kind: "file", fileDirectory: directory, path: "notes.txt" }],
  })
  await persistent.set(bucket, "layout", raw)
  directoryReplies.set(directory, { root: "/retry-root", fail: true })
  await expect(selectPanels({ directory, sessionID })).rejects.toThrow()
  expect(await persistent.get(bucket, "layout")).toBe(raw)
  const restored = await selectPanels({ directory, sessionID })
  expect(restored.state.tabs[0]).toMatchObject({ fileDirectory: "/retry-root", path: "sub/notes.txt" })
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
  const directory = `/workspace/${crypto.randomUUID()}`
  const target = { directory: `${directory}-worktree`, sessionID: crypto.randomUUID() }
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
  const target = { directory, sessionID: crypto.randomUUID() }
  const transfer = promotePanels(directory, target)
  await Promise.resolve()
  await draft.remove(id)
  finish()
  await transfer
  expect((await selectPanels(target)).state.tabs).toEqual([])
})
