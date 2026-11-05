import { test, expect } from "./fixture"

test.use({
  git: true,
  script: {
    reply: ({ toolResults }) => {
      if (!toolResults.length) return { tool: "read", args: { filePath: "notes.txt" } }
      if (toolResults.length === 1)
        return { tool: "write", args: { filePath: "notes.txt", content: "reviewed edit\n" } }
      return { text: "Review ready" }
    },
  },
})

for (const restart of [false, true])
  test(`sleeping review feedback blocks checkout after ${restart ? "application restart" : "reload"}`, async ({
    kit,
  }) => {
    await kit.mode(/全面接管|Full takeover/)
    kit.git("branch", "feature")
    await kit.send("Create a review")
    await expect(kit.text("Review ready")).toBeVisible()
    kit.git("add", "notes.txt")
    kit.git("commit", "--quiet", "-m", "review fixture")
    const owner = new URL(kit.page.url()).pathname
    await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
    await kit
      .panel()
      .getByRole("group", { name: /^notes\.txt 第 1 块$/ })
      .locator(".line.add .line-comment-add")
      .click()
    await kit.panel().getByRole("textbox", { name: "评论", exact: true }).fill("Keep sleeping feedback")
    if (restart) await kit.panel().getByRole("button", { name: "添加", exact: true }).click()
    await kit.page
      .getByRole("navigation", { name: "对话" })
      .getByRole("button", { name: "新对话", exact: true })
      .click()
    await kit.mode(/全面接管|Full takeover/)
    await kit.send("Other conversation")
    await expect(kit.text("Review ready")).toBeVisible()
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
    if (restart)
      await expect(
        kit
          .panel()
          .getByRole("region", { name: "notes.txt", exact: true })
          .getByText("Keep sleeping feedback", { exact: true }),
      ).toBeVisible()
    else
      await expect(kit.panel().getByRole("textbox", { name: "评论", exact: true })).toHaveValue(
        "Keep sleeping feedback",
      )
    await kit.panel().getByRole("button", { name: "关闭 审阅", exact: true }).click()
    await kit.page.getByRole("dialog").getByRole("button", { name: /^放弃/ }).click()
    await kit.page.locator(`a[href="${other}"]`).click()
    await kit
      .panel()
      .getByRole("button", { name: /^当前分支/ })
      .click()
    const feature = kit.page.getByRole("option", { name: /^feature/ })
    await expect(feature).not.toHaveAttribute("aria-disabled", "true")
    await feature.click()
    await expect.poll(() => kit.git("branch", "--show-current").trim()).toBe("feature")
  })
