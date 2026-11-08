import { access, readFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

test.use({ git: true, claude: true, script: { reply: () => ({ tool: "say", args: { text: "隔离任务已记录。" } }) } })

for (const spelling of ["original", "alternate"]) {
  test(`runs a member claim in its own worktree with an ${spelling} project path`, async ({ kit }) => {
    const branch = kit.git("branch", "--show-current").trim()
    const head = kit.git("rev-parse", "HEAD").trim()
    await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
    const dialog = kit.page.getByRole("dialog")
    await dialog.getByRole("textbox", { name: "群名称" }).fill("隔离协作")
    if (spelling === "alternate")
      await dialog.getByRole("textbox", { name: "项目目录" }).fill(kit.project.replaceAll("\\", "/") + "/")
    await dialog.getByRole("checkbox", { name: "选择 Claude Code", exact: true }).check()
    await dialog.getByRole("button", { name: "创建", exact: true }).click()
    await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
    await kit.send("@Claude Code 检查隔离任务")
    const worktrees = () =>
      kit
        .git("worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice(9).trim())
    await expect.poll(() => worktrees().length).toBe(2)
    const worktree = worktrees().find((directory) => path.resolve(directory) !== path.resolve(kit.project))!
    expect(path.relative(kit.project, worktree).split(path.sep).slice(0, 2)).toEqual([".merak", "worktrees"])
    await expect
      .poll(() => readFile(path.join(worktree, "inputs.json"), "utf8").catch(() => ""))
      .toContain("检查隔离任务")
    await expect(kit.page.getByRole("group", { name: "成员 Claude Code", exact: true })).toContainText("空闲")
    await expect(access(path.join(kit.project, "inputs.json"))).rejects.toThrow()
    expect(kit.git("branch", "--show-current").trim()).toBe(branch)
    expect(kit.git("rev-parse", "HEAD").trim()).toBe(head)
    expect(kit.git("branch", "--list", "merak/*").trim()).not.toBe("")
    await kit.page.reload()
    await expect(kit.page.getByRole("log", { name: "群聊" })).toContainText("@Claude Code 检查隔离任务")
    expect(worktrees()).toContain(worktree)
  })
}
