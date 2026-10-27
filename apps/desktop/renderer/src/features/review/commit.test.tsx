import type { VcsRunResult } from "@merakcode/sdk/client"
import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, expect, test, vi } from "vitest"
import { setLocale, t } from "../../i18n"
import { client } from "../../state/client"
import { setState } from "../../state/store"
import { Commit } from "./commit"

const dir = "D:/work"

let cleanup = () => {}

afterEach(() => {
  cleanup()
  cleanup = () => {}
  vi.restoreAllMocks()
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

async function runQuickCommand(host: HTMLElement, command: string, output: string) {
  const result: VcsRunResult = { output, exitCode: 1 }
  vi.spyOn(client(dir).vcs, "run").mockResolvedValue({ data: result, error: undefined })
  button(host, t("review.quickCommand"))?.click()
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${t("review.quickCommand")}"]`)
  input!.value = command
  input!.dispatchEvent(new InputEvent("input", { bubbles: true }))
  button(host, t("review.quickRun"))?.click()
  await vi.waitFor(() => expect(host.querySelector(".git-output")?.textContent).toBe(output))
}

test("the branch overview shows ahead, behind and how many files changed", () => {
  setState("branch", dir, "main")
  setState("remote", dir, { name: "origin", ahead: 1, behind: 0, staged: 2, unstaged: 3, untracked: 1 })
  const host = mount(() => <Commit directory={dir} all={false} onDone={() => {}} />)
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
  const host = mount(() => <Commit directory={dir} all={false} onDone={() => {}} />)
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
  const host = mount(() => <Commit directory={dir} all={false} onDone={() => {}} />)
  const push = button(host, t("review.push"))
  expect(push?.hasAttribute("disabled")).toBe(false)
  expect(push?.parentElement?.getAttribute("title")).toBe(t("review.pushUpstream", { remote: "origin" }))
})

test("a destructive git command asks before it runs", () => {
  setState("branch", dir, "main")
  setState("remote", dir, { name: "origin", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 })
  const host = mount(() => <Commit directory={dir} all={false} onDone={() => {}} />)
  button(host, t("review.quickCommand"))?.click()
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${t("review.quickCommand")}"]`)
  expect(input).toBeTruthy()
  input!.value = "reset --hard"
  input!.dispatchEvent(new InputEvent("input", { bubbles: true }))
  host.querySelector(".git-command")?.querySelector("button")?.click()
  expect(document.body.textContent).toContain(t("review.quickConfirm"))
  expect(host.querySelector(".git-output")).toBeNull()
})

test("the quick command output can be closed", async () => {
  setState("branch", dir, "main")
  setState("remote", dir, { name: "origin", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 })
  const host = mount(() => <Commit directory={dir} all={false} onDone={() => {}} />)
  await runQuickCommand(host, "push", "fatal: nothing to push")
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("common.close")}"]`)?.click()
  expect(host.querySelector(".git-output")).toBeNull()
})

test("closing the quick command hides its output until it reopens", async () => {
  setState("branch", dir, "main")
  setState("remote", dir, { name: "origin", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 })
  const host = mount(() => <Commit directory={dir} all={false} onDone={() => {}} />)
  await runQuickCommand(host, "push", "fatal: nothing to push")
  button(host, t("review.quickCommand"))?.click()
  expect(host.querySelector(".git-command")).toBeNull()
  expect(host.querySelector(".git-output")).toBeNull()
  button(host, t("review.quickCommand"))?.click()
  expect(host.querySelector(".git-output")?.textContent).toBe("fatal: nothing to push")
})

test("push stays available and is disabled when the branch has nothing to push", () => {
  setState("branch", dir, "main")
  setState("remote", dir, { name: "origin", ahead: 0, behind: 0, staged: 1, unstaged: 0, untracked: 0 })
  const host = mount(() => <Commit directory={dir} all={false} onDone={() => {}} />)
  const push = button(host, t("review.push"))
  expect(push).toBeTruthy()
  expect(push?.hasAttribute("disabled")).toBe(true)
  expect(push?.parentElement?.getAttribute("title")).toBe(t("review.pushNothing"))
})
