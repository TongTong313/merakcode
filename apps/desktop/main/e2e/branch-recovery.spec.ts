import { expect, test } from "./fixture"

test.use({ git: true })

test("a failed first message can move to a worktree while retaining the original conversation", async ({ kit }) => {
  const rpc = await kit.rpc()
  rpc.fail("session.send", "MRK-1001")
  const sidebar = kit.page.getByRole("navigation", { name: "对话" })
  const rows = () => sidebar.getByRole("link").filter({ hasNotText: /^(首页|Home)$/ })
  const draft = kit.page.getByRole("textbox", { name: "消息", exact: true })
  await kit.send("Continue this task in a worktree")
  await expect(kit.page.getByRole("status").filter({ hasText: "MRK-1001" })).toBeVisible()
  await expect(draft).toHaveValue("Continue this task in a worktree")
  await expect(rows()).toHaveCount(1)
  const original = await rows().getAttribute("href")

  await kit.page.getByRole("button", { name: "新工作树", exact: true }).click()
  await draft.press("Enter")
  await expect(kit.text("OK")).toBeVisible()
  await expect(rows()).toHaveCount(2)
  expect(kit.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2)
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  await kit.openPanel("git")
  await kit
    .panel()
    .getByRole("button", { name: /^当前分支/ })
    .click()
  await expect(kit.page.getByText("此工作树与会话绑定，当前分支只读", { exact: true })).toBeVisible()
  await kit.page.keyboard.press("Escape")

  await sidebar.locator(`a[href="${original}"]`).click()
  await expect(kit.page).toHaveURL(new RegExp(`${original}$`))
  await kit.send("Retry in the original directory")
  await expect(kit.text("OK")).toBeVisible()
  await expect(rows()).toHaveCount(2)
})

test("retrying a lost worktree creation response reuses the created worktree and retains the task draft", async ({
  kit,
}) => {
  const rpc = await kit.rpc()
  rpc.loseResponse("worktree.create")
  const sidebar = kit.page.getByRole("navigation", { name: "对话" })
  const rows = () => sidebar.getByRole("link").filter({ hasNotText: /^(首页|Home)$/ })
  const draft = kit.page.getByRole("textbox", { name: "消息", exact: true })
  await kit.page.getByRole("button", { name: "新工作树", exact: true }).click()
  await kit.send("Recover the created worktree")
  await expect(kit.page.getByRole("status").filter({ hasText: "MRK-1001" })).toBeVisible()
  await expect(draft).toHaveValue("Recover the created worktree")
  expect(kit.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2)
  await expect(rows()).toHaveCount(0)

  await draft.press("Enter")
  await expect(kit.text("OK")).toBeVisible()
  await expect(rows()).toHaveCount(1)
  expect(kit.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2)
})

test("retrying a lost session creation response reuses the session and its worktree with the draft intact", async ({
  kit,
}) => {
  const rpc = await kit.rpc()
  rpc.loseResponse("session.create")
  const sidebar = kit.page.getByRole("navigation", { name: "对话" })
  const rows = () => sidebar.getByRole("link").filter({ hasNotText: /^(首页|Home)$/ })
  const draft = kit.page.getByRole("textbox", { name: "消息", exact: true })
  await kit.page.getByRole("button", { name: "新工作树", exact: true }).click()
  await kit.send("Recover the created conversation")
  await expect(kit.page.getByRole("status").filter({ hasText: "MRK-1001" })).toBeVisible()
  await expect(draft).toHaveValue("Recover the created conversation")
  await expect(rows()).toHaveCount(1)
  const created = await rows().getAttribute("href")
  expect(kit.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2)

  await draft.press("Enter")
  await expect(kit.text("OK")).toBeVisible()
  await expect(kit.page).toHaveURL(new RegExp(`${created}$`))
  await expect(rows()).toHaveCount(1)
  expect(kit.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2)
})
