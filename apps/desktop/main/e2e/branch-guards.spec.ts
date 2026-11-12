import { expect, test } from "./fixture"

test.beforeEach(async ({ kit }) => {
  await kit.mode(/全面接管|Full takeover/)
})

test.use({
  git: true,
  script: {
    reply: ({ toolResults }) => {
      if (!toolResults.length) return { tool: "read_file", args: { path: "notes.txt" } }
      if (toolResults.length === 1)
        return { tool: "write_file", args: { path: "notes.txt", content: "changed by agent\n" } }
      return { text: "Ready to review" }
    },
  },
})

test("review drafts in another tab keep branch switching blocked until explicitly discarded", async ({ kit }) => {
  kit.git("branch", "feature")
  await kit.send("Update notes")
  await expect(kit.text("Ready to review")).toBeVisible()
  kit.git("add", "notes.txt")
  kit.git("commit", "--quiet", "-m", "review fixture")
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await kit
    .panel()
    .getByRole("group", { name: /^notes\.txt 第 1 块$/ })
    .locator(".line.add .line-comment-add")
    .click()
  await kit.panel().getByRole("textbox", { name: "评论", exact: true }).fill("keep feedback in tab A")
  await kit.panel().getByRole("button", { name: "添加", exact: true }).click()
  await kit.openPanel("browser", true)
  await expect(kit.panel().getByText(/1 条评论待发送/)).toHaveCount(0)
  await kit.openPanel("git")
  await kit
    .panel()
    .getByRole("button", { name: /^当前分支/ })
    .click()
  await expect(kit.page.getByText("请先发送或清除未发送的审阅评论及输入草稿", { exact: true })).toBeVisible()
  await expect(kit.page.getByRole("option", { name: /^feature/ })).toHaveAttribute("aria-disabled", "true")
  await kit.page.keyboard.press("Escape")
  await kit.panel().getByRole("button", { name: "关闭 审阅", exact: true }).click()
  await kit.page.getByRole("dialog").getByRole("button", { name: /^放弃/ }).click()
  await kit
    .panel()
    .getByRole("button", { name: /^当前分支/ })
    .click()
  await expect(kit.page.getByRole("option", { name: /^feature/ })).not.toHaveAttribute("aria-disabled", "true")
  await kit.page.keyboard.press("Escape")
})

test("an unsubmitted review comment survives panel changes and blocks branch switching", async ({ kit }) => {
  const current = kit.git("branch", "--show-current").trim()
  kit.git("branch", "feature")
  await kit.send("Update notes")
  await expect(kit.text("Ready to review")).toBeVisible({ timeout: 60_000 })
  kit.git("add", "notes.txt")
  kit.git("commit", "--quiet", "-m", "agent update")
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  await panel
    .getByRole("group", { name: /^notes\.txt 第 1 块$/ })
    .locator(".line.add .line-comment-add")
    .click()
  const draft = panel.getByRole("textbox", { name: "评论", exact: true })
  await draft.fill("Keep this review draft")
  await kit.openPanel("git")
  const working = panel.getByRole("button", { name: /^当前分支/ })
  await kit.openPanel("git")
  await working.click()
  await expect(kit.page.getByText("请先发送或清除未发送的审阅评论及输入草稿", { exact: true })).toBeVisible()
  await expect(kit.page.getByRole("option", { name: /^feature/ })).toHaveAttribute("aria-disabled", "true")
  await kit.page.keyboard.press("Escape")
  await kit.openPanel("file")
  await kit.openPanel("review")
  await expect(draft).toHaveValue("Keep this review draft")
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await expect(panel.getByText(/1 条评论待发送/)).toBeVisible()
  await kit.openPanel("git")
  await working.click()
  await expect(kit.page.getByText("请先发送或清除未发送的审阅评论及输入草稿", { exact: true })).toBeVisible()
  await expect(kit.page.getByRole("option", { name: /^feature/ })).toHaveAttribute("aria-disabled", "true")
  await kit.page.keyboard.press("Escape")
  await kit.openPanel("review")
  await panel.getByRole("button", { name: "清空", exact: true }).click()
  await kit.openPanel("git")
  await working.click()
  await expect(kit.page.getByRole("option", { name: /^feature/ })).not.toHaveAttribute("aria-disabled", "true")
  await kit.page.keyboard.press("Escape")
  expect(kit.git("branch", "--show-current").trim()).toBe(current)
})

test("unsaved editor contents survive closing the code panel and still block branch switching", async ({ kit }) => {
  const rpc = await kit.rpc()
  const home = kit.page.getByRole("button", { name: /^当前分支/ }).first()
  await home.click()
  await expect(kit.page.getByRole("option")).toHaveCount(1)
  await kit.page.keyboard.press("Escape")
  kit.git("branch", "feature")
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  const panel = kit.panel()
  await kit.openPanel("file")
  await panel.getByRole("treeitem", { name: "notes.txt" }).click()
  const editor = panel.getByRole("code")
  await expect(editor).toContainText("hello from e2e")
  await editor.click()
  await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
  await kit.page.keyboard.type("unsaved branch draft")
  // Each branch lookup reads the branch list once; hold every one of them
  const held = rpc.hold("repo.branches")
  try {
    await kit.openPanel("git")
    const picker = panel.getByRole("button", { name: /^当前分支/ })
    await picker.hover()
    await expect.poll(() => held.calls.length).toBe(1)
    await picker.focus()
    await picker.click()
    await expect(kit.page.getByText("请先保存或明确放弃未保存的文件编辑", { exact: true })).toBeVisible()
    // Opening forces a fresh lookup so a branch created after the hover prefetch is not missed.
    await expect.poll(() => held.calls.length).toBe(2)
    await home.dispatchEvent("pointerenter")
    // The home control joins that forced lookup and keeps the same unsaved-file protection.
    expect(held.calls).toHaveLength(2)
    held.release()
    await expect(kit.page.getByRole("option", { name: /^feature/ })).toHaveAttribute("aria-disabled", "true")
  } finally {
    held.release()
  }
  await kit.page.keyboard.press("Escape")
  await kit.openPanel("file")
  await expect(editor).toContainText("unsaved branch draft")
  expect(kit.git("status", "--porcelain").trim()).toBe("")
  await kit.page.getByRole("button", { name: "项目操作" }).click()
  await kit.page.getByRole("menuitem", { name: "从列表移除" }).click()
  await expect(kit.page.getByRole("region", { name: "project", exact: true })).toBeVisible()
  await expect(kit.page.getByText("请先保存或明确放弃未保存的文件编辑", { exact: true })).toBeVisible()
  await expect(editor).toContainText("unsaved branch draft")
})

test("a commit on the same branch preserves the pending review and unsubmitted draft", async ({ kit }) => {
  await kit.send("Update notes")
  await expect(kit.text("Ready to review")).toBeVisible({ timeout: 60_000 })
  kit.git("add", "notes.txt")
  kit.git("commit", "--quiet", "-m", "agent update")
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  await panel.locator(".line.add .line-comment-add").click()
  const draft = panel.getByRole("textbox", { name: "评论", exact: true })
  await draft.fill("Keep this draft after commit")
  kit.git("commit", "--allow-empty", "--quiet", "-m", "keep draft")
  await expect(draft).toHaveValue("Keep this draft after commit")
  await kit.openPanel("git")
  await panel.getByRole("button", { name: "刷新 Git 状态" }).click()
  await kit.openPanel("review")
  await expect(panel.getByRole("region", { name: "notes.txt" })).toBeVisible()
  await expect(draft).toHaveValue("Keep this draft after commit")
})
