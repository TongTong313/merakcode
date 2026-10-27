import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { test, expect, type Kit } from "./fixture"

// Source Control stages, commits and pushes independently of pending conversation review.

let current: Kit
test.use({
  git: true,
  script: {
    reply: ({ toolResults }) =>
      toolResults.length
        ? { text: "写好了" }
        : { tool: "write", args: { filePath: path.join(current.project, "new.txt"), content: "new\n" } },
  },
})

test.beforeEach(({ kit }) => {
  current = kit
})

test("stages a file written by the agent, commits it and pushes to the remote", async ({ kit }) => {
  const remote = path.join(kit.root, "remote.git")
  execFileSync("git", ["init", "--bare", "--quiet", remote])
  kit.git("remote", "add", "origin", remote)
  await kit.send("写个文件")
  await expect(kit.text("写好了")).toBeVisible({ timeout: 60_000 })

  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  await writeFile(path.join(kit.project, "manual.txt"), "keep unstaged\n")
  const pending = panel.locator('[data-group="unstaged"] .git-file').filter({ hasText: "new.txt" })
  await pending.getByRole("button", { name: "暂存 new.txt", exact: true }).click()
  await expect(panel.locator('[data-group="staged"] .git-file').filter({ hasText: "new.txt" })).toBeVisible()
  await expect(panel.locator(".diff")).toHaveCount(0)
  await expect(panel.getByRole("button", { name: "快捷命令", exact: true })).toHaveCount(0)
  await kit.page.screenshot({ path: test.info().outputPath("source-control.png") })

  await panel.getByRole("textbox", { name: "提交信息" }).fill("add new")
  await panel.getByRole("button", { name: "提交 Commit" }).click()
  await expect.poll(() => kit.git("log", "-1", "--format=%s").trim()).toBe("add new")
  await expect(panel.locator('[data-group="staged"] .git-file')).toHaveCount(0)
  expect(kit.git("status", "--porcelain")).toContain("manual.txt")

  const branch = kit.git("rev-parse", "--abbrev-ref", "HEAD").trim()
  await panel.getByRole("button", { name: /^推送/ }).click()
  // git log fails while the remote lacks the branch; treat that as not pushed yet
  const pushed = () => {
    try {
      return execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s", branch], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    } catch {
      return ""
    }
  }
  await expect.poll(pushed).toBe("add new")
  await expect(panel.getByRole("button", { name: /^推送/ })).toBeDisabled()
})

test("rejecting after an unreviewed push preserves history and undo restores Git review navigation", async ({
  kit,
}) => {
  const remote = path.join(kit.root, "remote.git")
  execFileSync("git", ["init", "--bare", "--quiet", remote])
  kit.git("remote", "add", "origin", remote)
  await kit.send("Write a file")
  await expect(kit.text("写好了")).toBeVisible({ timeout: 60_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  await panel.getByRole("button", { name: "暂存 new.txt", exact: true }).click()
  await panel.getByRole("textbox", { name: "提交信息" }).fill("commit without review")
  await panel.getByRole("button", { name: "提交 Commit" }).click()
  await expect.poll(() => kit.git("log", "-1", "--format=%s").trim()).toBe("commit without review")
  const head = kit.git("rev-parse", "HEAD").trim()
  const branch = kit.git("branch", "--show-current").trim()
  await panel.getByRole("button", { name: /^推送/ }).click()
  await expect
    .poll(() => {
      try {
        return execFileSync("git", ["--git-dir", remote, "rev-parse", branch], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim()
      } catch {
        return ""
      }
    })
    .toBe(head)
  await expect(panel.getByRole("button", { name: /^推送/ })).toBeDisabled()
  await panel.getByRole("tab", { name: /^审阅/ }).click()
  await panel.getByRole("region", { name: "new.txt" }).getByRole("button", { name: "拒绝文件" }).click()
  await expect.poll(() => readFile(path.join(kit.project, "new.txt"), "utf8").catch(() => "missing")).toBe("missing")
  expect(kit.git("rev-parse", "HEAD").trim()).toBe(head)
  expect(kit.git("show", ":new.txt")).toBe("new\n")
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  await expect(panel.locator('[data-group="unstaged"] .git-file').filter({ hasText: "new.txt" })).toBeVisible()
  await expect(panel.getByRole("button", { name: "查看待审改动 new.txt" })).toHaveCount(0)
  await panel.getByRole("tab", { name: /^审阅/ }).click()
  await panel.getByRole("button", { name: "撤销" }).click()
  await expect(panel.getByRole("region", { name: "new.txt" })).toBeVisible()
  expect(await readFile(path.join(kit.project, "new.txt"), "utf8")).toBe("new\n")
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  await expect(panel.locator(".git-file")).toHaveCount(0)
  // A later working edit creates a Git row where the restored pending review can be opened.
  await writeFile(path.join(kit.project, "new.txt"), "new again\n")
  await panel.getByRole("button", { name: "刷新 Git 状态" }).click()
  await expect(panel.getByRole("button", { name: "查看待审改动 new.txt" })).toBeVisible()
  await panel.getByRole("button", { name: "查看待审改动 new.txt" }).click()
  await expect(panel.getByRole("region", { name: "new.txt" })).toBeVisible()
  await expect(panel.getByRole("radio", { name: "整个对话" })).toBeChecked()
  expect(kit.git("rev-parse", "HEAD").trim()).toBe(head)
  expect(execFileSync("git", ["--git-dir", remote, "rev-parse", branch], { encoding: "utf8" }).trim()).toBe(head)
})

test("Git selection and all-file index actions preserve working files and pending review", async ({ kit }) => {
  await kit.send("Write a file")
  await expect(kit.text("写好了")).toBeVisible({ timeout: 60_000 })
  await writeFile(path.join(kit.project, "manual-a.txt"), "manual A\n")
  await writeFile(path.join(kit.project, "manual-b.txt"), "manual B\n")
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  const staged = panel.locator('[data-group="staged"]')
  const unstaged = panel.locator('[data-group="unstaged"]')
  await unstaged.getByRole("checkbox", { name: "选择 manual-a.txt" }).check()
  await unstaged.getByRole("checkbox", { name: "选择 manual-b.txt" }).check()
  await unstaged.getByRole("button", { name: "暂存所选 2 个文件" }).click()
  await expect
    .poll(() => kit.git("diff", "--cached", "--name-only").trim().split("\n"))
    .toEqual(["manual-a.txt", "manual-b.txt"])
  await staged.getByRole("checkbox", { name: "选择 manual-a.txt" }).check()
  await staged.getByRole("button", { name: "取消暂存所选 1 个文件" }).click()
  await expect.poll(() => kit.git("diff", "--cached", "--name-only").trim()).toBe("manual-b.txt")
  await unstaged.getByRole("button", { name: "暂存全部", exact: true }).click()
  await expect(staged.locator(".git-file")).toHaveCount(3)
  await staged.getByRole("button", { name: "全部取消暂存", exact: true }).click()
  await expect(staged.locator(".git-file")).toHaveCount(0)
  await expect(unstaged.locator(".git-file")).toHaveCount(3)
  expect(await readFile(path.join(kit.project, "manual-a.txt"), "utf8")).toBe("manual A\n")
  expect(await readFile(path.join(kit.project, "manual-b.txt"), "utf8")).toBe("manual B\n")
  expect(await readFile(path.join(kit.project, "new.txt"), "utf8")).toBe("new\n")
  await expect(panel.getByRole("button", { name: "查看待审改动 new.txt" })).toBeVisible()
  await expect(panel.getByRole("button", { name: "查看待审改动 manual-a.txt" })).toHaveCount(0)
})
