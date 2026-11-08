import { expect, test } from "./fixture"

test.use({ git: true })

test("Git branch management has its own panel outside review scopes", async ({ kit }) => {
  const current = kit.git("branch", "--show-current").trim()
  kit.git("branch", "feature")
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  const panel = kit.panel()
  await expect(panel.getByRole("toolbar", { name: "审阅工具栏" }).getByRole("radio")).toHaveCount(0)
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  await expect(panel.getByRole("button", { name: /^比对分支/ })).toHaveCount(0)
  const working = panel.getByRole("button", { name: /^当前分支/ })
  await expect(working).toContainText(current)
  await working.click()
  await kit.page.getByRole("option", { name: /^feature/ }).click()
  await expect(working).toContainText("feature")
  expect(kit.git("branch", "--show-current").trim()).toBe("feature")
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
  await kit.panel().getByRole("tab", { name: "Git 管理" }).click()
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
  await expect(kit.page.getByRole("alert")).toContainText("MRK-5001")
  expect(kit.git("branch", "--show-current").trim()).toBe(current)
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
