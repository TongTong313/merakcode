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
  const rpc = await kit.rpc()
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  const panel = kit.panel()
  await kit.openPanel("file")
  await panel.getByRole("treeitem", { name: "notes.txt" }).click()
  await expect(panel.getByRole("code")).toContainText("hello from e2e")
  const errors: string[] = []
  kit.page.on("pageerror", (error) => errors.push(error.message))

  // The reload that the checkout triggers reads notes.txt; that read is held until the file was reopened
  const reload = rpc.hold("file.read", { match: (params) => params.path === "notes.txt", times: 1 })
  try {
    kit.git("switch", "--quiet", "feature")
    await reload.entered
    await panel.getByRole("button", { name: "关闭 notes.txt", exact: true }).click()
    await kit.openPanel("file")
    await panel.getByRole("treeitem", { name: "notes.txt" }).click()
    const editor = panel.getByRole("code")
    await expect(editor).toContainText("feature branch content")
    await editor.click()
    await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
    await kit.page.keyboard.type("keep the reopened draft")
    reload.release()
    await expect.poll(() => rpc.seen("file.read", (params) => params.path === "notes.txt").length).toBeGreaterThan(1)

    await kit.openPanel("git")
    await panel.getByRole("button", { name: /^当前分支/ }).click()
    await expect(kit.page.getByText("请先保存或明确放弃未保存的文件编辑", { exact: true })).toBeVisible()
    await expect(kit.page.getByRole("option", { name: new RegExp(`^${main}(?:\\s|$)`) })).toHaveAttribute(
      "aria-disabled",
      "true",
    )
    await kit.page.keyboard.press("Escape")
    await kit.openPanel("file")
    await expect(editor).toContainText("keep the reopened draft")
    expect(kit.git("status", "--porcelain").trim()).toBe("")
    expect(errors).toEqual([])
  } finally {
    reload.release()
  }
})
