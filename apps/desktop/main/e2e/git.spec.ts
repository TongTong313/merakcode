import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, test } from "./fixture"

test.use({ git: true })

test("shows staged and unstaged files and opens the same baseline diff", async ({ kit }) => {
  await kit.send("Start the conversation baseline")
  await expect(kit.text("OK")).toBeVisible()
  await writeFile(path.join(kit.project, "staged.txt"), "staged content\n")
  kit.git("add", "staged.txt")
  await writeFile(path.join(kit.project, "unstaged.txt"), "working content\n")
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  const panel = kit.panel()
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  const staged = panel.locator(".git-group").filter({ has: kit.page.locator("summary").filter({ hasText: "已暂存" }) })
  const unstaged = panel
    .locator(".git-group")
    .filter({ has: kit.page.locator("summary").filter({ hasText: "未暂存" }) })
  await expect(staged.getByRole("button", { name: "查看待审改动 staged.txt" })).toBeVisible()
  await expect(unstaged.getByRole("button", { name: "查看待审改动 unstaged.txt" })).toBeVisible()
  await expect(panel.getByRole("button", { name: /^(提交|暂存 |取消暂存 )/ })).toHaveCount(0)
  await staged.getByRole("button", { name: "查看待审改动 staged.txt" }).click()
  await expect(panel.getByRole("tab", { name: /^审阅/ })).toHaveAttribute("aria-selected", "true")
  await expect(panel.getByRole("region", { name: "staged.txt", exact: true })).toContainText("staged content")
  expect(kit.git("diff", "--cached", "--name-only").trim()).toBe("staged.txt")
  expect(await readFile(path.join(kit.project, "unstaged.txt"), "utf8")).toBe("working content\n")
})

test("opens a working file in the read-only code viewer", async ({ kit }) => {
  await writeFile(path.join(kit.project, "source.ts"), "export const answer = 42\n")
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  const panel = kit.panel()
  await panel.getByRole("tab", { name: "代码", exact: true }).click()
  await panel.getByRole("treeitem", { name: /source.ts/ }).dblclick()
  await expect(panel.locator(".monaco-editor")).toContainText("answer")
  expect(await readFile(path.join(kit.project, "source.ts"), "utf8")).toBe("export const answer = 42\n")
})
