import { expect, test } from "./fixture"

test.use({
  git: true,
  script: {
    reply: ({ toolResults }) => {
      if (!toolResults.length) return { tool: "read", args: { filePath: "notes.txt" } }
      if (toolResults.length === 1)
        return { tool: "write", args: { filePath: "notes.txt", content: "changed by agent\n" } }
      return { text: "Ready to review" }
    },
  },
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
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  const working = panel.getByRole("button", { name: /^当前分支/ })
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  await working.click()
  await expect(kit.page.getByText("请先发送或清除未发送的审阅评论及输入草稿", { exact: true })).toBeVisible()
  await expect(kit.page.getByRole("option", { name: /^feature/ })).toHaveAttribute("aria-disabled", "true")
  await kit.page.keyboard.press("Escape")
  await panel.getByRole("tab", { name: "代码", exact: true }).click()
  await panel.getByRole("tab", { name: /^审阅/ }).click()
  await expect(draft).toHaveValue("Keep this review draft")
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await expect(panel.getByText(/1 条评论待发送/)).toBeVisible()
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  await working.click()
  await expect(kit.page.getByText("请先发送或清除未发送的审阅评论及输入草稿", { exact: true })).toBeVisible()
  await expect(kit.page.getByRole("option", { name: /^feature/ })).toHaveAttribute("aria-disabled", "true")
  await kit.page.keyboard.press("Escape")
  await panel.getByRole("tab", { name: /^审阅/ }).click()
  await panel.getByRole("button", { name: "清空", exact: true }).click()
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  await working.click()
  await expect(kit.page.getByRole("option", { name: /^feature/ })).not.toHaveAttribute("aria-disabled", "true")
  await kit.page.keyboard.press("Escape")
  expect(kit.git("branch", "--show-current").trim()).toBe(current)
})

test("unsaved editor contents survive closing the code panel and still block branch switching", async ({ kit }) => {
  const loaded = await kit.page.reload()
  const authorization = (await loaded!.request().allHeaders()).authorization
  expect(authorization).toBeTruthy()
  const home = kit.page.getByRole("button", { name: /^当前分支/ }).first()
  await home.click()
  await expect(kit.page.getByRole("option")).toHaveCount(1)
  await Promise.all([
    kit.page.waitForResponse((response) => new URL(response.url()).pathname === "/vcs/branch-options"),
    kit.page.keyboard.press("Escape"),
  ])
  kit.git("branch", "feature")
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  const panel = kit.panel()
  await panel.getByRole("tab", { name: "代码", exact: true }).click()
  await panel.getByRole("treeitem", { name: "notes.txt" }).click()
  const editor = panel.getByRole("code")
  await expect(editor).toContainText("hello from e2e")
  await editor.click()
  await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
  await kit.page.keyboard.type("unsaved branch draft")
  const held: { release: () => void; done: Promise<void> }[] = []
  let capture = true
  const pattern = /\/vcs\/branch-options(?:\?|$)/
  await kit.page.route(pattern, async (route) => {
    if (!capture) return route.continue()
    const gate = Promise.withResolvers<void>()
    const done = Promise.withResolvers<void>()
    held.push({ release: () => gate.resolve(), done: done.promise })
    try {
      const response = await route.fetch({ headers: { ...route.request().headers(), authorization: authorization! } })
      await gate.promise
      await route.fulfill({ response })
    } finally {
      done.resolve()
    }
  })
  try {
    await panel.getByRole("tab", { name: "Git 管理" }).click()
    const picker = panel.getByRole("button", { name: /^当前分支/ })
    const nextRead = async (act: () => Promise<unknown>) => {
      const before = held.length
      await act()
      await expect.poll(() => held.length).toBeGreaterThan(before)
    }
    // Observe each request before starting the next interaction, including the menu's own refresh.
    await nextRead(() => picker.hover())
    await nextRead(() => picker.focus())
    await nextRead(() => picker.click())
    await expect(kit.page.getByText("请先保存或明确放弃未保存的文件编辑", { exact: true })).toBeVisible()
    const older = held.slice()
    await nextRead(() => home.dispatchEvent("pointerenter"))
    for (const response of older) response.release()
    await Promise.all(older.map((response) => response.done))
    // A checkout update can require another read; only the intended overlapping requests stay gated.
    capture = false
    for (const response of held) response.release()
    await Promise.all(held.map((response) => response.done))
    await expect(kit.page.getByRole("option", { name: /^feature/ })).toHaveAttribute("aria-disabled", "true")
  } finally {
    capture = false
    for (const response of held) response.release()
    await Promise.all(held.map((response) => response.done))
    await kit.page.unroute(pattern)
  }
  await kit.page.keyboard.press("Escape")
  await panel.getByRole("tab", { name: "代码", exact: true }).click()
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
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  await panel.getByRole("button", { name: "刷新 Git 状态" }).click()
  await panel.getByRole("tab", { name: /^审阅/ }).click()
  await expect(panel.getByRole("region", { name: "notes.txt" })).toBeVisible()
  await expect(draft).toHaveValue("Keep this draft after commit")
})
