import { readFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

test.use({ git: true, script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) } })

for (const restart of [false, true])
  test(`a sleeping conversation draft blocks checkout after ${restart ? "application restart" : "reload"} until discarded`, async ({
    kit,
  }) => {
    kit.git("branch", "feature")
    await kit.send("draft owner")
    await expect(kit.text("Reply: draft owner")).toBeVisible()
    const owner = new URL(kit.page.url()).pathname
    await kit.openPanel("file")
    await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
    const editor = () => kit.panel().getByRole("code").first()
    await expect(editor()).toContainText("hello from e2e")
    await editor().click()
    await kit.page.keyboard.press("ControlOrMeta+End")
    await kit.page.keyboard.type("keep on original branch")
    await kit.page
      .getByRole("navigation", { name: "对话" })
      .getByRole("button", { name: "新对话", exact: true })
      .click()
    await kit.send("other conversation")
    await expect(kit.text("Reply: other conversation")).toBeVisible()
    await kit.openPanel("git")
    const other = new URL(kit.page.url()).pathname
    if (restart) {
      const previousPID = kit.app.process().pid
      await kit.restart()
      expect(kit.app.process().pid).not.toBe(previousPID)
      await kit.page.locator(`a[href="${other}"]`).click()
    } else await kit.page.reload()
    await kit
      .panel()
      .getByRole("button", { name: /^当前分支/ })
      .click()
    await expect(kit.page.getByRole("option", { name: /^feature/ })).toHaveAttribute("aria-disabled", "true")
    await kit.page.keyboard.press("Escape")
    await kit.page.locator(`a[href="${owner}"]`).click()
    await expect(editor()).toContainText("keep on original branch")
    expect(await readFile(path.join(kit.project, "notes.txt"), "utf8")).toBe("hello from e2e\n")
    await kit.panel().getByRole("button", { name: "关闭 notes.txt", exact: true }).click()
    await kit.page.getByRole("dialog").getByRole("button", { name: /^放弃/ }).click()
    await expect(kit.page.getByRole("dialog")).toHaveCount(0)
    await expect(kit.panel().getByRole("tab")).toHaveCount(0)
    await kit.page.locator(`a[href="${other}"]`).click()
    await kit
      .panel()
      .getByRole("button", { name: /^当前分支/ })
      .click()
    await expect(kit.page.getByRole("option", { name: /^feature/ })).not.toHaveAttribute("aria-disabled", "true")
  })

test("a restored draft cannot save to another branch with identical file contents", async ({ kit }) => {
  kit.git("branch", "feature")
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
  const editor = kit.panel().getByRole("code").first()
  await expect(editor).toContainText("hello from e2e")
  await editor.click()
  await kit.page.keyboard.press("ControlOrMeta+End")
  await kit.page.keyboard.type("draft must stay on its branch")
  await kit.openPanel("git")
  kit.git("switch", "--quiet", "feature")
  await kit.page.reload()
  await kit
    .panel()
    .getByRole("tab", { name: /^notes\.txt/ })
    .click()
  await expect(editor).toContainText("draft must stay on its branch")
  await editor.click()
  await kit.page.keyboard.press("ControlOrMeta+S")
  await expect(kit.page.getByText("工作目录已变化；未保存内容已保留，请先核对磁盘版本").first()).toBeVisible()
  expect(await readFile(path.join(kit.project, "notes.txt"), "utf8")).toBe("hello from e2e\n")
  await expect(kit.panel().getByRole("tab", { name: /^notes\.txt/ })).toContainText("●")
})
