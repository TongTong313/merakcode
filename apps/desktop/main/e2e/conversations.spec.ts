import { test, expect } from "./fixture"

// Parallel conversations: while one is running, a new one can be used; the sidebar shows each conversation's state
// (running / awaiting approval); command palette

/**
 * The "slow task" prompt runs until release(); the "needs approval" prompt first runs a command that needs approval;
 * anything else gets an immediate reply
 */
let release = () => {}
const slow = () => new Promise<void>((resolve) => (release = resolve))

test.use({
  script: {
    reply: async ({ prompt, toolResults }) => {
      if (prompt.includes("慢任务")) {
        await slow()
        return { text: "慢任务完成" }
      }
      if (prompt.includes("要审批"))
        return toolResults.length
          ? { text: "审批过了" }
          : { tool: "bash", args: { command: 'node -e "console.log(1)"', description: "run node" } }
      return { text: `回复：${prompt}` }
    },
  },
})

test("a new conversation works while another runs; the sidebar shows it running, then its result", async ({ kit }) => {
  const sidebar = kit.page.getByRole("navigation", { name: /^(对话|Conversations)$/ })
  await kit.send("慢任务")
  await expect(sidebar.getByRole("link", { name: /运行中/ })).toHaveCount(1, { timeout: 60_000 })

  await sidebar.getByRole("button", { name: "新对话" }).click()
  await kit.send("快任务")
  await expect(kit.text("回复：快任务")).toBeVisible({ timeout: 60_000 })
  await expect(sidebar.getByRole("link")).toHaveCount(2)
  await expect(sidebar.getByRole("link", { name: /运行中/ })).toHaveCount(1)

  release()
  await expect(sidebar.getByRole("link", { name: /运行中/ })).toHaveCount(0, { timeout: 60_000 })
  // Conversations are sorted by last update, so the slow task that just finished is on top
  await sidebar.getByRole("link").first().click()
  await expect(kit.text("慢任务完成")).toBeVisible()
})

test("the sidebar marks a conversation awaiting approval, and opening it allows approving", async ({ kit }) => {
  const sidebar = kit.page.getByRole("navigation", { name: /^(对话|Conversations)$/ })
  await kit.send("要审批")
  await expect(kit.approval()).toBeVisible({ timeout: 60_000 })

  await sidebar.getByRole("button", { name: "新对话" }).click()
  await expect(kit.approval()).toHaveCount(0)
  const waiting = sidebar.getByRole("link", { name: /待审批/ })
  await expect(waiting).toHaveCount(1)
  await waiting.click()
  await kit.approval().getByText("允许", { exact: true }).click()
  await expect(kit.text("审批过了")).toBeVisible({ timeout: 60_000 })
  await expect(sidebar.getByRole("link", { name: /待审批/ })).toHaveCount(0)
})

test("command palette opens with Ctrl+K and runs the typed command on Enter", async ({ kit }) => {
  await kit.send("快任务")
  await expect(kit.text("回复：快任务")).toBeVisible({ timeout: 60_000 })
  await kit.page.keyboard.press("Control+K")
  const palette = kit.page.getByRole("dialog", { name: "命令面板" })
  await expect(palette).toBeVisible()
  await palette.getByRole("combobox").fill("新对话")
  await kit.page.keyboard.press("Enter")
  await expect(palette).toHaveCount(0)
  await expect(kit.page.getByText("要在 project 里做什么？")).toBeVisible()
})
