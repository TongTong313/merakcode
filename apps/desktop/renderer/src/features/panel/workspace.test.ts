import { expect, test } from "vitest"
import { fileOwners } from "../code/references"
import { openPanel, panels, promotePanels, selectPanels } from "./workspace"

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
