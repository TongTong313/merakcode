import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { test, expect, type Kit } from "./fixture"

// git: stage, commit and push from the review panel; branch review can change the base branch; open files from changes

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
  await panel.getByRole("radio", { name: "未暂存" }).click()
  await panel.getByRole("region", { name: "new.txt" }).getByRole("button", { name: "接受文件" }).click()
  await expect(panel.getByRole("region", { name: "new.txt" })).toHaveCount(0)
  await panel.getByRole("radio", { name: "已暂存" }).click()
  await expect(panel.getByRole("region", { name: "new.txt" })).toBeVisible()

  await panel.getByRole("textbox", { name: "提交信息" }).fill("add new")
  await panel.getByRole("button", { name: "提交", exact: true }).click()
  await expect.poll(() => kit.git("log", "-1", "--format=%s").trim()).toBe("add new")
  await expect(panel.getByRole("region", { name: "new.txt" })).toHaveCount(0)

  const branch = kit.git("rev-parse", "--abbrev-ref", "HEAD").trim()
  await panel.getByRole("button", { name: /^推送/ }).click()
  // git log fails while the remote lacks the branch; treat that as not pushed yet
  const pushed = () => {
    try {
      return execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s", branch], { encoding: "utf8" }).trim()
    } catch {
      return ""
    }
  }
  await expect.poll(pushed).toBe("add new")
})

test("branch review lists only changes against the chosen base branch and opens files from changes", async ({
  kit,
}) => {
  const main = kit.git("rev-parse", "--abbrev-ref", "HEAD").trim()
  kit.git("checkout", "--quiet", "-b", "dev")
  await writeFile(path.join(kit.project, "dev.txt"), "dev\n")
  kit.git("add", ".")
  kit.git("commit", "--quiet", "-m", "dev")
  kit.git("checkout", "--quiet", "-b", "feature")
  await mkdir(path.join(kit.project, "src"), { recursive: true })
  await writeFile(path.join(kit.project, "src", "f.txt"), "feature\n")
  kit.git("add", ".")
  kit.git("commit", "--quiet", "-m", "feature")
  await kit.page.reload()

  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  const panel = kit.panel()
  await panel.getByRole("tab", { name: /^审阅/ }).click()
  await panel.getByRole("radio", { name: "分支" }).click()
  await expect(panel.getByRole("region", { name: "dev.txt" })).toBeVisible()
  await expect(panel.getByRole("region", { name: "src/f.txt" })).toBeVisible()

  await panel.getByRole("button", { name: new RegExp(`^基准分支 ${main}`) }).click()
  await kit.page.getByRole("option", { name: "dev" }).click()
  await expect(panel.getByRole("region", { name: "dev.txt" })).toHaveCount(0)
  await expect(panel.getByRole("region", { name: "src/f.txt" })).toBeVisible()

  await panel.getByRole("region", { name: "src/f.txt" }).getByRole("button", { name: "在代码中打开" }).click()
  await expect(panel.getByRole("tab", { name: "代码" })).toHaveAttribute("aria-selected", "true")
  await expect(panel.getByRole("code")).toContainText("feature")
})
