import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, test } from "./fixture"

test.use({ git: true })

test("review uses one toolbar and selecting its remembered base enters comparison without checkout", async ({
  kit,
}) => {
  const current = kit.git("branch", "--show-current").trim()
  kit.git("branch", "feature")
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  const panel = kit.panel()
  const toolbar = panel.getByRole("toolbar", { name: "审阅工具栏" })
  const working = toolbar.getByRole("button", { name: /^当前分支/ })
  const base = toolbar.getByRole("button", { name: /^比对分支/ })
  await expect(working).toContainText(current)
  await expect(toolbar.getByRole("radio", { name: "本轮" })).toHaveCount(0)
  await expect(toolbar.getByRole("radio", { name: "会话" })).toHaveCount(0)
  await expect(toolbar.getByRole("radio", { name: "分支对比" })).toHaveCount(0)
  await expect(toolbar.getByRole("radiogroup").getByRole("button", { name: /^当前分支/ })).toHaveCount(0)
  const bounds = await Promise.all([
    working.boundingBox(),
    base.boundingBox(),
    toolbar.getByRole("radiogroup").boundingBox(),
  ])
  expect(Math.max(...bounds.map((box) => box!.y)) - Math.min(...bounds.map((box) => box!.y))).toBeLessThan(6)

  await base.click()
  await kit.page.getByRole("option", { name: /^feature/ }).click()
  await expect(base).toHaveAttribute("aria-pressed", "true")
  expect(kit.git("branch", "--show-current").trim()).toBe(current)
  await toolbar.getByRole("radio", { name: "未暂存" }).click()
  await base.click()
  await kit.page.keyboard.press("Escape")
  await expect(toolbar.getByRole("radio", { name: "未暂存" })).toHaveAttribute("aria-checked", "true")
  await base.click()
  await kit.page.getByRole("option", { name: /^feature/ }).click()
  await expect(base).toHaveAttribute("aria-pressed", "true")
})

test("home switches the actual branch in two steps and review shows that checkout", async ({ kit }) => {
  kit.git("branch", "feature")
  const working = kit.page.locator(".context-row").getByRole("button", { name: /^当前分支/ })
  await working.click()
  await kit.page.getByRole("option", { name: /^feature/ }).click()
  await expect(working).toContainText("feature")
  await expect(working).toBeFocused()
  expect(kit.git("branch", "--show-current").trim()).toBe("feature")
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  await expect(kit.panel().getByRole("button", { name: /^当前分支/ })).toContainText("feature")
})

test("opening a detached checkout shows its short commit and permits returning to a local branch", async ({ kit }) => {
  const branch = kit.git("branch", "--show-current").trim()
  kit.git("checkout", "--quiet", "--detach")
  const commit = kit.git("rev-parse", "--short=7", "HEAD").trim()
  await kit.page.reload()
  const working = kit.page.getByRole("button", { name: /^当前分支/ })
  await expect(working).toContainText(commit)
  await working.click()
  await expect(working).toContainText(commit)
  await kit.page.getByRole("option", { name: new RegExp(`^${branch}(?:\\s|$)`) }).click()
  await expect(working).toContainText(branch)
  expect(kit.git("branch", "--show-current").trim()).toBe(branch)
})

test("a deleted branch is reported in the UI language and leaves the current checkout unchanged", async ({ kit }) => {
  const current = kit.git("branch", "--show-current").trim()
  kit.git("branch", "feature")
  await kit.page
    .locator(".context-row")
    .getByRole("button", { name: /^当前分支/ })
    .click()
  const target = kit.page.getByRole("option", { name: /^feature/ })
  await expect(target).toBeVisible()
  kit.git("branch", "-D", "feature")
  await target.click()
  await expect(kit.page.getByRole("alert")).toContainText("目标分支无效，请刷新列表后选择仍然存在的本地分支")
  expect(kit.git("branch", "--show-current").trim()).toBe(current)
})

test("a worktree starting branch is only used when sending and never checks out the main directory", async ({
  kit,
}) => {
  const main = kit.git("branch", "--show-current").trim()
  kit.git("checkout", "--quiet", "-b", "feature")
  await writeFile(path.join(kit.project, "base.txt"), "from feature\n")
  kit.git("add", ".")
  kit.git("commit", "--quiet", "-m", "feature base")
  kit.git("checkout", "--quiet", main)
  await writeFile(path.join(kit.project, "local.txt"), "uncommitted\n")
  const create = kit.page.getByRole("button", { name: "新工作树", exact: true })
  await create.click()
  const base = kit.page.getByRole("button", { name: /^起点分支/ })
  await base.click()
  await kit.page.getByRole("option", { name: /^feature/ }).click()
  expect(kit.git("branch", "--show-current").trim()).toBe(main)
  expect(kit.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1)
  await kit.page.getByRole("button", { name: "取消新工作树" }).click()
  await expect(base).toHaveCount(0)
  await create.click()
  await base.click()
  await kit.page.getByRole("option", { name: /^feature/ }).click()
  await kit.send("start from feature")
  await expect(kit.text("OK")).toBeVisible({ timeout: 60_000 })
  const trees = kit
    .git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
  expect(trees).toHaveLength(2)
  const directory = trees[1]!.slice("worktree ".length)
  expect(execFileSync("git", ["-C", directory, "show", "HEAD:base.txt"], { encoding: "utf8" })).toBe("from feature\n")
  await expect(readFile(path.join(directory, "local.txt"))).rejects.toThrow()
  expect(kit.git("branch", "--show-current").trim()).toBe(main)
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  await kit
    .panel()
    .getByRole("button", { name: /^当前分支/ })
    .click()
  await expect(kit.page.getByText("此工作树与会话绑定，当前分支只读", { exact: true })).toBeVisible()
  await kit.page.keyboard.press("Escape")
})

test("a rejected worktree starting branch preserves the draft and permits cancelling and retrying", async ({ kit }) => {
  const current = kit.git("branch", "--show-current").trim()
  kit.git("branch", "feature")
  await kit.page.getByRole("button", { name: "新工作树", exact: true }).click()
  const base = kit.page.getByRole("button", { name: /^起点分支/ })
  await base.click()
  await kit.page.getByRole("option", { name: /^feature/ }).click()
  kit.git("branch", "-D", "feature")
  await kit.send("Preserve this task after a rejected start")
  await expect(kit.page.locator(".toast.error")).toBeVisible()
  await expect(kit.page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(
    "Preserve this task after a rejected start",
  )
  const cancel = kit.page.getByRole("button", { name: "取消新工作树" })
  await expect(cancel).toBeEnabled()
  await base.click()
  await kit.page.getByRole("option", { name: new RegExp(`^${current}(?:\\s|$)`) }).click()
  await cancel.click()
  await expect(base).toHaveCount(0)
  await kit.page.getByRole("button", { name: "新工作树", exact: true }).click()
  await kit.send("Preserve this task after a rejected start")
  await expect(kit.text("OK")).toBeVisible({ timeout: 60_000 })
  expect(kit.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2)
  expect(kit.git("branch", "--show-current").trim()).toBe(current)
})

test("switching to the comparison base clears it and the same branch context survives full screen", async ({ kit }) => {
  kit.git("branch", "feature")
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  const panel = kit.panel()
  const base = panel.getByRole("button", { name: /^比对分支/ })
  await base.click()
  await kit.page.getByRole("option", { name: /^feature/ }).click()
  await panel.getByRole("button", { name: /^当前分支/ }).click()
  await kit.page.getByRole("option", { name: /^feature/ }).click()
  await expect(base).toContainText("选择分支")
  await expect(panel.getByRole("button", { name: /^当前分支/ })).toContainText("feature")
  await panel.getByRole("button", { name: "铺满" }).click()
  const toolbar = kit.page.getByRole("toolbar", { name: "审阅工具栏" })
  await expect(toolbar.getByRole("button", { name: /^当前分支/ })).toContainText("feature")
  await expect(toolbar.getByRole("button", { name: /^比对分支/ })).toContainText("选择分支")
  await kit.page.getByRole("button", { name: "返回对话" }).click()
  await expect(kit.page.locator(".context-row").getByRole("button", { name: /^当前分支/ })).toContainText("feature")
})

test("deleting the selected comparison branch externally clears it without another picker interaction", async ({
  kit,
}) => {
  const pending = new Set<{ url(): string }>()
  const isBranches = (url: string) => new URL(url).pathname === "/vcs/branch-options"
  kit.page.on("request", (request) => {
    if (isBranches(request.url())) pending.add(request)
  })
  const finished = (request: { url(): string }) => {
    pending.delete(request)
  }
  kit.page.on("requestfinished", finished)
  kit.page.on("requestfailed", finished)
  kit.git("branch", "feature")
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  const panel = kit.panel()
  const base = panel.getByRole("button", { name: /^比对分支/ })
  await base.click()
  await kit.page.getByRole("option", { name: /^feature/ }).click()
  await expect(base).toContainText("feature")
  await panel.getByRole("radio", { name: "未暂存" }).click()
  await expect.poll(() => pending.size).toBe(0)
  kit.git("branch", "-D", "feature")
  await expect(base).toContainText("选择分支")
  await expect(panel.getByRole("radio", { name: "未暂存" })).toHaveAttribute("aria-checked", "true")
})

test("a prepared worktree and its task draft survive opening full-screen review", async ({ kit }) => {
  const draft = kit.page.getByRole("textbox", { name: "消息", exact: true })
  await draft.fill("Keep this task draft")
  await kit.page.getByRole("button", { name: "新工作树", exact: true }).click()
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  await kit.panel().getByRole("button", { name: "铺满" }).click()
  await kit.page.getByRole("button", { name: "返回对话" }).click()
  await expect(draft).toHaveValue("Keep this task draft")
  await expect(kit.page.getByRole("button", { name: /^起点分支/ })).toBeVisible()
})

test.describe("outside Git", () => {
  test.use({ git: false })
  test("a directory without Git only shows applicable review controls", async ({ kit }) => {
    await expect(kit.page.getByRole("button", { name: /^当前分支/ })).toHaveCount(0)
    await expect(kit.page.getByRole("button", { name: "新工作树", exact: true })).toHaveCount(0)
    await kit.page.getByRole("button", { name: "右侧面板" }).click()
    await expect(kit.panel().getByRole("radio", { name: "未暂存" })).toHaveCount(0)
    await expect(kit.panel().getByRole("radio", { name: "已暂存" })).toHaveCount(0)
    await expect(kit.panel().getByRole("button", { name: /^比对分支/ })).toHaveCount(0)
  })
})
