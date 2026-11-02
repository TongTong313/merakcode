import { expect, test } from "vitest"
import { createPanels } from "./state"
import { createEffect, createRoot, on } from "solid-js"

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
