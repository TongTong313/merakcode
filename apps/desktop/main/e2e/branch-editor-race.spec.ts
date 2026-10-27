import { writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, test } from "./fixture"

test.use({ git: true })

test("a delayed checkout reload does not target a closed editor after the same file is reopened", async ({ kit }) => {
  const main = kit.git("branch", "--show-current").trim()
  kit.git("switch", "--quiet", "-c", "feature")
  await writeFile(path.join(kit.project, "notes.txt"), "feature branch content\n")
  kit.git("add", "notes.txt")
  kit.git("commit", "--quiet", "-m", "feature notes")
  kit.git("switch", "--quiet", main)
  await kit.page.reload()
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  const panel = kit.panel()
  await panel.getByRole("tab", { name: "代码", exact: true }).click()
  await panel.getByRole("treeitem", { name: "notes.txt" }).click()
  await expect(panel.getByRole("code")).toContainText("hello from e2e")
  const errors: string[] = []
  kit.page.on("pageerror", (error) => errors.push(error.message))

  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const delivered = Promise.withResolvers<void>()
  await kit.page.route(
    (url) => url.pathname === "/file/content" && url.searchParams.get("path") === "notes.txt",
    async (route) => {
      const response = await route.fetch()
      entered.resolve()
      await release.promise
      await route.fulfill({ response })
      delivered.resolve()
    },
    { times: 1 },
  )
  try {
    kit.git("switch", "--quiet", "feature")
    await entered.promise
    await panel.getByRole("button", { name: "关闭 notes.txt", exact: true }).click()
    await panel.getByRole("treeitem", { name: "notes.txt" }).click()
    const editor = panel.getByRole("code")
    await expect(editor).toContainText("feature branch content")
    await editor.click()
    await kit.page.keyboard.press("Control+End")
    await kit.page.keyboard.type("keep the reopened draft")
    release.resolve()
    await delivered.promise

    await panel.getByRole("tab", { name: "Git 管理" }).click()
    await panel.getByRole("button", { name: /^当前分支/ }).click()
    await expect(kit.page.getByText("请先保存或明确放弃未保存的文件编辑", { exact: true })).toBeVisible()
    await expect(kit.page.getByRole("option", { name: new RegExp(`^${main}(?:\\s|$)`) })).toHaveAttribute(
      "aria-disabled",
      "true",
    )
    await kit.page.keyboard.press("Escape")
    await panel.getByRole("tab", { name: "代码", exact: true }).click()
    await expect(editor).toContainText("keep the reopened draft")
    expect(kit.git("status", "--porcelain").trim()).toBe("")
    expect(errors).toEqual([])
  } finally {
    release.resolve()
  }
})
