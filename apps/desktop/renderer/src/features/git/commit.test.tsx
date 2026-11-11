import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, expect, test } from "vitest"
import { setLocale, t } from "../../i18n"
import { setState } from "../../state/store"
import { Commit } from "./commit"
import { selectPanels } from "../panel/workspace"

const dir = "D:/work"

let cleanup = () => {}

afterEach(() => {
  document.querySelectorAll<HTMLTextAreaElement>(".commit textarea").forEach((box) => {
    box.value = ""
    box.dispatchEvent(new InputEvent("input", { bubbles: true }))
  })
  cleanup()
  cleanup = () => {}
  setState("branch", dir, undefined)
  setState("remote", dir, undefined)
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

function button(host: HTMLElement, label: string) {
  return [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(label))
}

test("the branch overview shows ahead, behind and how many files changed", () => {
  setState("branch", dir, "main")
  setState("remote", dir, { name: "origin", ahead: 1, behind: 0, staged: 2, unstaged: 3, untracked: 1 })
  const host = mount(() => <Commit directory={dir} onDone={() => {}} />)
  const text = host.querySelector(".vcs-summary")?.textContent ?? ""
  expect(text).toContain("main")
  expect(text).toContain(t("review.ahead", { count: 1 }))
  expect(text).toContain(t("review.behind", { count: 0 }))
  expect(text).toContain(t("review.stagedCount", { count: 2 }))
  expect(text).toContain(t("review.unstagedCount", { count: 3 }))
  expect(text).toContain(t("review.untrackedCount", { count: 1 }))
  expect(button(host, t("review.pushCount", { count: 1 }))?.hasAttribute("disabled")).toBe(false)
})

test("commit stays disabled until there is a message and something to commit", () => {
  setState("branch", dir, "main")
  setState("remote", dir, { name: "origin", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 })
  const host = mount(() => <Commit directory={dir} onDone={() => {}} />)
  const commit = () => button(host, t("review.commit"))
  expect(commit()?.hasAttribute("disabled")).toBe(true)
  expect(commit()?.parentElement?.getAttribute("title")).toBe(t("review.commitNeedMessage"))
  const input = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t("review.commitMessage")}"]`)
  expect(input).toBeTruthy()
  input!.value = "add new"
  input!.dispatchEvent(new InputEvent("input", { bubbles: true }))
  expect(commit()?.hasAttribute("disabled")).toBe(true)
  expect(commit()?.parentElement?.getAttribute("title")).toBe(t("review.commitNothing"))
})

test("the first push is enabled when the branch has a remote and no upstream yet", () => {
  setState("branch", dir, "main")
  setState("remote", dir, { name: "origin", staged: 0, unstaged: 0, untracked: 0 })
  const host = mount(() => <Commit directory={dir} onDone={() => {}} />)
  const push = button(host, t("review.push"))
  expect(push?.hasAttribute("disabled")).toBe(false)
  expect(push?.parentElement?.getAttribute("title")).toBe(t("review.pushUpstream", { remote: "origin" }))
})

test("push stays available and is disabled when the branch has nothing to push", () => {
  setState("branch", dir, "main")
  setState("remote", dir, { name: "origin", ahead: 0, behind: 0, staged: 1, unstaged: 0, untracked: 0 })
  const host = mount(() => <Commit directory={dir} onDone={() => {}} />)
  const push = button(host, t("review.push"))
  expect(push).toBeTruthy()
  expect(push?.hasAttribute("disabled")).toBe(true)
  expect(push?.parentElement?.getAttribute("title")).toBe(t("review.pushNothing"))
})

test("recovered commit messages can be selected without losing the current draft", async () => {
  const owner = await selectPanels({ directory: "/recovered-commits", sessionID: crypto.randomUUID() })
  const id = owner.open({ kind: "git", view: { commit: "first", commitAlternatives: ["second"] } })
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <Commit directory="/recovered-commits" instanceID={id} onDone={() => {}} />, host)
  try {
    const chooser = host.querySelector("select")!
    expect(chooser).not.toBeNull()
    const input = host.querySelector("textarea")!
    input.value = "first with newer edits"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    chooser.value = "0"
    chooser.dispatchEvent(new Event("change", { bubbles: true }))
    expect(input.value).toBe("second")
    await owner.flush()
    expect(owner.view(id).commitAlternatives).toContain("first with newer edits")
  } finally {
    dispose()
    host.remove()
  }
})
