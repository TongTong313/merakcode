import { expect, test } from "vitest"
import { createPanels } from "./state"
import { createEffect, createRoot, on } from "solid-js"

test("file aliases share a tab across opening, restoration and adoption while worktrees stay distinct", async () => {
  let saved: string | null = null
  const persistence = {
    get: async () => saved,
    set: async (_key: string, value: string) => {
      saved = value
    },
  }
  const owner = await createPanels("paths", persistence, "/project")
  const first = owner.open({ kind: "file", path: "src/../notes.txt" })
  expect(owner.open({ kind: "file", path: "/project/notes.txt", fileDirectory: "/project" })).toBe(first)
  expect(owner.open({ kind: "file", path: "notes.txt", fileDirectory: "/other-tree" })).not.toBe(first)
  saved = JSON.stringify({
    version: 1,
    selected: "selected",
    tabs: [
      { id: "old", kind: "file", path: "./notes.txt" },
      { id: "selected", kind: "file", path: "src/../notes.txt", view: { line: 7 } },
    ],
  })
  const restored = await createPanels("paths", persistence, "/project")
  expect(restored.state.tabs).toHaveLength(1)
  expect(restored.state.selected).toBe("selected")
  await restored.adopt({ version: 1, tabs: [{ id: "incoming", kind: "file", path: "/project/notes.txt" }] })
  expect(restored.state.tabs).toHaveLength(1)
  expect(restored.state.tabs[0]).toMatchObject({ path: "notes.txt", fileDirectory: "/project", view: { line: 7 } })
})

test.each(["review", "git", "plan"] as const)(
  "each conversation reuses its only %s tab and preserves drafts",
  async (kind) => {
    const saved = new Map<string, string>()
    const persistence = {
      get: async (key: string) => saved.get(key) ?? null,
      set: async (key: string, value: string) => void saved.set(key, value),
    }
    const owner = await createPanels("single", persistence)
    const first = owner.open({
      kind,
      view: { scope: "turn", messageID: "first", commit: "keep", drafts: { a: { text: "keep draft" } } },
    })
    const next = owner.open({ kind, view: { scope: "session", messageID: undefined, focus: "next.txt" } })
    expect(next).toBe(first)
    expect(owner.state.tabs).toHaveLength(1)
    expect(owner.view(first)).toMatchObject({
      scope: "session",
      focus: "next.txt",
      commit: "keep",
      drafts: { a: { text: "keep draft" } },
    })
    expect(owner.view(first).messageID).toBeUndefined()
    const other = await createPanels("other", persistence)
    expect(other.open({ kind })).not.toBe(first)
    await owner.remove(first)
    expect(owner.open({ kind })).not.toBe(first)
  },
)

test("legacy layouts merge singleton drafts durably and repeated adoption preserves the selected tab", async () => {
  const target = {
    key: "same",
    directory: "/project",
    sessionID: "chat",
    scope: "turn",
    file: "notes.txt",
    version: "v1",
    side: "new",
    rows: [],
  }
  const legacy = {
    version: 1,
    selected: "r2",
    visible: true,
    tabs: [
      {
        id: "r1",
        kind: "review",
        view: {
          comments: { chat: [{ ...target, id: 1, text: "first comment" }] },
          drafts: { same: { target, text: "first draft" } },
        },
      },
      { id: "browser", kind: "browser" },
      {
        id: "r2",
        kind: "review",
        view: {
          scope: "session",
          comments: { chat: [{ ...target, id: 1, text: "second comment" }] },
          drafts: { same: { target, text: "second draft" } },
        },
      },
      { id: "g1", kind: "git", view: { commit: "first commit" } },
      { id: "g2", kind: "git", view: { commit: "second commit" } },
      { id: "p1", kind: "plan" },
      { id: "p2", kind: "plan" },
    ],
  }
  let saved = JSON.stringify(legacy)
  const persistence = {
    get: async () => saved,
    set: async (_key: string, value: string) => {
      saved = value
    },
  }
  const owner = await createPanels("legacy", persistence)
  expect(owner.state.tabs.map((tab) => tab.id)).toEqual(["browser", "r2", "g1", "p1"])
  expect(owner.state.selected).toBe("r2")
  const first = JSON.parse(saved)
  await owner.adopt(legacy)
  await owner.adopt(legacy)
  const restored = await createPanels("legacy", persistence)
  expect(restored.state.tabs).toEqual(first.tabs)
  expect(restored.state.selected).toBe("r2")
  const comments = (restored.view("r2").comments as { chat: { id: number; text: string }[] }).chat
  expect(comments.map((item) => item.text).sort()).toEqual(["first comment", "second comment"])
  expect(new Set(comments.map((item) => item.id)).size).toBe(2)
  const drafts = restored.view("r2").drafts as Record<string, { target: { key: string }; text: string }>
  expect(
    Object.values(drafts)
      .map((draft) => draft.text)
      .sort(),
  ).toEqual(["first draft", "second draft"])
  for (const [key, draft] of Object.entries(drafts)) expect(draft.target.key).toBe(key)
  expect(restored.view("g1").commit).toBe("first commit")
  expect(restored.view("g1").commitAlternatives).toEqual(["second commit"])
})

test("merging review editors preserves distinct edits and never inherits a stale comment target", async () => {
  const target = { key: "same", directory: "/review", sessionID: "chat", editing: 1 }
  const legacy = {
    version: 1,
    selected: "keep",
    tabs: [
      {
        id: "keep",
        kind: "review",
        view: { comments: { chat: [{ id: 1, text: "keep" }] }, drafts: { same: { target, text: "identical edit" } } },
      },
      {
        id: "other",
        kind: "review",
        view: {
          comments: { chat: [{ id: 1, text: "other" }] },
          commenting: target,
          drafts: { same: { target, text: "identical edit" } },
        },
      },
    ],
  }
  let saved = JSON.stringify(legacy)
  const owner = await createPanels("review-edits", {
    get: async () => saved,
    set: async (_key, value) => {
      saved = value
    },
  })
  const view = owner.view("keep")
  const drafts = Object.values(view.drafts as Record<string, { target: { editing: number } }>)
  expect(drafts).toHaveLength(2)
  expect(new Set(drafts.map((draft) => draft.target.editing))).toEqual(new Set([1, 2]))
  expect(view.commenting).toBeUndefined()
  await owner.adopt(legacy)
  expect(Object.keys(owner.view("keep").drafts as object)).toHaveLength(2)
})

test("rapid view updates persist the latest layout in one write", async () => {
  const writes: string[] = []
  const persistence = {
    get: async () => writes.at(-1) ?? null,
    set: async (_key: string, value: string) => {
      writes.push(value)
    },
  }
  const editor = await createPanels("view-burst", persistence)
  const id = editor.open({ kind: "file", path: "file.txt" })
  const pending = [1, 2, 3].map((line) => editor.patchView(id, { editor: { line } }))
  await editor.flush()
  await Promise.all(pending)
  const restored = await createPanels("view-burst", persistence)
  expect(restored.view(id).editor).toEqual({ line: 3 })
  expect(writes).toHaveLength(1)
})

test("concurrent view patches keep keys written by other callers", async () => {
  const owner = await createPanels("view-merge", {
    get: async () => null,
    set: async () => {},
  })
  const id = owner.open({ kind: "git", view: { closed: ["unstaged"] } })
  await Promise.all([
    owner.patchView(id, { commit: "latest handwritten message", commitRevision: 1 }),
    owner.patchView(id, { selected: ["staged:manual.txt"], closed: ["unstaged"] }),
  ])
  expect(owner.view(id)).toMatchObject({
    commit: "latest handwritten message",
    commitRevision: 1,
    selected: ["staged:manual.txt"],
    closed: ["unstaged"],
  })
})

test("conversations restore independent tabs and deduplicate file navigation", async () => {
  const saved = new Map<string, string>()
  const persistence = {
    get: async (key: string) => saved.get(key) ?? null,
    set: async (key: string, value: string) => void saved.set(key, value),
  }
  const a = await createPanels("conversation-a", persistence)
  expect(a.state.tabs).toEqual([])
  const file = a.open({ kind: "file", path: "src/app.ts" })
  expect(a.open({ kind: "file", path: "src/app.ts" })).toBe(file)
  a.open({ kind: "terminal" })
  await a.flush()
  const b = await createPanels("conversation-b", persistence)
  expect(b.state.tabs).toEqual([])
  b.open({ kind: "git" })
  await b.flush()
  const restored = await createPanels("conversation-a", persistence)
  expect(restored.state.tabs.map((tab) => tab.kind)).toEqual(["file", "terminal"])
  expect(restored.state.selected).toBe(restored.state.tabs[1]!.id)
  expect(b.state.tabs.map((tab) => tab.kind)).toEqual(["git"])
})

test("reused review navigation observes the new file focus immediately", async () => {
  const editor = await createPanels("review-navigation", { get: async () => null, set: async () => {} })
  const id = editor.open({ kind: "review", view: { scope: "session", focus: "old.ts" } })
  let observed: unknown
  const dispose = createRoot((dispose) => {
    createEffect(
      on(
        () => editor.state.tabs[0]?.navigation,
        () => {
          observed = editor.view(id).focus
        },
      ),
    )
    return dispose
  })
  try {
    await Promise.resolve()
    expect(editor.open({ kind: "review", view: { scope: "session", focus: "new.ts" } }, true)).toBe(id)
    expect(observed).toBe("new.ts")
  } finally {
    dispose()
  }
})
