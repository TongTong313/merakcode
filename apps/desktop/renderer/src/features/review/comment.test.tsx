import type { ReviewFile, ReviewFileDetail, ReviewHunk } from "@merakcode/sdk/client"
import { createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, expect, test } from "vitest"
import { setLocale, t } from "../../i18n"
import { ReviewPanel, type ReviewData } from "./review"
import { clearComments, setReview } from "./state"

const file: ReviewFile = {
  file: "src/math.js",
  status: "modified",
  additions: 1,
  deletions: 0,
  hunks: 1,
  accepted: 0,
  version: "v1",
}

const hunk: ReviewHunk = {
  id: "h1",
  oldStart: 1,
  oldLines: 3,
  newStart: 1,
  newLines: 3,
  lines: [
    { kind: "context", old: 1, new: 1, text: "a" },
    { kind: "add", new: 2, text: "two" },
    { kind: "context", old: 2, new: 3, text: "b" },
  ],
}

const detail: ReviewFileDetail = { file: file.file, version: file.version, hunks: [hunk] }

function data(): ReviewData {
  return {
    data: () => ({ scope: "turn", checkout: null, actions: { accept: true, reject: true }, files: [file] }),
    error: () => undefined,
    loading: () => false,
    refreshing: () => false,
    decide: async () => {},
    undo: async () => {},
    refetch: async () => {},
    detail: () => ({ detail }),
    loadDetail: async () => detail,
    loadTokens: async () => {},
    open: () => true,
    setOpen: () => {},
    all: () => true,
    showAll: () => {},
  }
}

let cleanup = () => {}

afterEach(() => {
  cleanup()
  cleanup = () => {}
  clearComments("s1")
  setReview({ commenting: undefined, scope: "turn" })
})

function mount(node: () => JSX.Element) {
  setLocale("zh")
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(node, host)
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host
}

test("clicking comment focuses the sidebar on that file and line", async () => {
  const host = mount(() => <ReviewPanel sessionID="s1" directory="D:/work" folder="D:/work" data={data()} />)
  const group = host.querySelector('[data-hunk="h1"]')
  group?.querySelector<HTMLButtonElement>(`button[aria-label="${t("review.comment")}"]`)?.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const box = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t("review.commentLabel")}"]`)
  expect(box?.disabled).toBe(false)
  expect(document.activeElement).toBe(box)
  expect(host.textContent).toContain("src/math.js:2")
  expect(group?.querySelector("textarea")).toBeNull()
})

test("a refresh of the review data keeps the comment being written", async () => {
  const [version, setVersion] = createSignal(0)
  const refreshing: ReviewData = {
    ...data(),
    // Every refresh hands out new objects for the same hunk
    detail: () => ({ detail: { ...detail, version: `v${version()}`, hunks: [{ ...hunk }] } }),
  }
  const host = mount(() => <ReviewPanel sessionID="s1" directory="D:/work" folder="D:/work" data={refreshing} />)
  host
    .querySelector('[data-hunk="h1"]')
    ?.querySelector<HTMLButtonElement>(`button[aria-label="${t("review.comment")}"]`)
    ?.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const box = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t("review.commentLabel")}"]`)!
  box.value = "这里改成 2"
  box.dispatchEvent(new InputEvent("input", { bubbles: true }))
  setVersion(1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(box.value).toBe("这里改成 2")
  const add = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === t("common.add"),
  )
  expect(add?.disabled).toBe(false)
})
