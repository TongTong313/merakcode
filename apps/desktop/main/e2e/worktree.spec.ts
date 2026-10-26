import { access, readFile } from "node:fs/promises"
import path from "node:path"
import { test, expect, type Kit } from "./fixture"

// Worktree conversations run in a new worktree, so agent changes leave the main working tree alone, and are merged
// back into the current branch when done. The conversation and its worktree share a lifetime: both can be cleaned up
// after merging, or deleted together when no longer needed.

test.use({
  git: true,
  script: {
    reply: ({ toolResults }) =>
      toolResults.length
        ? { text: "写好了" }
        : { tool: "write", args: { filePath: "feature.txt", content: "from worktree\n" } },
  },
})

/** Starts a conversation in a new worktree and waits for the agent to finish writing */
async function start(kit: Kit) {
  await kit.page.getByRole("button", { name: "新工作树", exact: true }).click()
  await kit.send("在 worktree 里写个文件")
  await expect(kit.text("写好了")).toBeVisible({ timeout: 90_000 })
  await expect(access(path.join(kit.project, "feature.txt"))).rejects.toThrow()
}

/** Number of worktrees besides the main one */
const worktrees = (kit: Kit) =>
  kit
    .git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length - 1

test("writes in a new worktree without touching the main tree; merging brings the file over and cleans up", async ({
  kit,
}) => {
  const errors: string[] = []
  kit.page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await start(kit)
  expect(errors).toEqual([])
  const sidebar = kit.page.getByRole("navigation", { name: "对话" })
  await expect(sidebar.getByRole("link")).toHaveCount(1)
  expect(worktrees(kit)).toBe(1)

  const main = kit.git("rev-parse", "--abbrev-ref", "HEAD").trim()
  await kit.page.getByRole("button", { name: `合并到 ${main}` }).click()
  const dialog = kit.page.getByRole("dialog")
  await expect(dialog.getByRole("switch", { name: /合并后清理/ })).toBeChecked()
  await dialog.getByRole("button", { name: "合并" }).click()
  await expect
    .poll(() => readFile(path.join(kit.project, "feature.txt"), "utf8").catch(() => ""))
    .toBe("from worktree\n")
  await expect(kit.text(/已合并到/)).toBeVisible()
  await expect.poll(() => worktrees(kit)).toBe(0)
  await expect(sidebar.getByRole("link")).toHaveCount(0)
  await expect(kit.page.getByText("要在 project 里做什么？")).toBeVisible()
})

test("deleting a worktree removes it with its branch and conversation, leaving the main tree alone", async ({
  kit,
}) => {
  await start(kit)
  await kit.page.getByRole("button", { name: "对话操作" }).last().click()
  await kit.page.getByRole("menuitem", { name: "删除 worktree" }).click()
  await kit.page.getByRole("dialog").getByRole("button", { name: "删除" }).click()
  await expect.poll(() => worktrees(kit)).toBe(0)
  await expect(kit.page.getByRole("navigation", { name: "对话" }).getByRole("link")).toHaveCount(0)
  // The branch goes last, after the worktree's folder is cleaned up, which takes a moment on Windows
  await expect.poll(() => kit.git("branch", "--list", "merakcode/*").trim()).toBe("")
  await expect(access(path.join(kit.project, "feature.txt"))).rejects.toThrow()
})
