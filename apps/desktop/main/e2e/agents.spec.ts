import { test, expect } from "./fixture"

// Subagents and workflows: open a subagent's conversation and return to the main one; workflows show progress and can
// be canceled

let release = () => {}
const slow = () => new Promise<void>((resolve) => (release = resolve))

const WORKFLOW = [
  "export const meta = { name: 'e2e-demo', description: 'E2E 工作流' }",
  "await agent('E2E_WF_SLOW 慢慢做', { label: '慢任务' })",
].join("\n")

test.use({
  script: {
    reply: async ({ prompt, toolResults }) => {
      if (prompt.includes("E2E_CHILD")) return { text: "子任务完成" }
      if (prompt.includes("E2E_WF_SLOW")) {
        await slow()
        return { text: "工作流子任务完成" }
      }
      if (prompt.includes("派子智能体"))
        return toolResults.length
          ? { text: "主对话完成" }
          : {
              tool: "subagent",
              args: { description: "查资料", prompt: "子任务：E2E_CHILD", subagent_type: "general" },
            }
      if (prompt.includes("跑工作流"))
        return toolResults.length ? { text: "工作流已启动" } : { tool: "workflow_run", args: { script: WORKFLOW } }
      return { text: "OK" }
    },
  },
})

test("clicking a subagent opens its conversation, with a way back to the main one", async ({ kit }) => {
  await kit.mode(/自动/)
  await kit.send("派子智能体去查")
  await expect(kit.text("主对话完成")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("button", { name: /查资料/ }).click()
  await expect(kit.text("子任务完成")).toBeVisible({ timeout: 30_000 })
  await kit.page.getByRole("button", { name: "返回主对话" }).click()
  await expect(kit.text("主对话完成")).toBeVisible()
})

test("the workflow card shows task progress and is marked canceled after canceling", async ({ kit }) => {
  await kit.mode(/自动/)
  await kit.send("跑工作流")
  const card = kit.page.getByRole("group", { name: /^工作流 e2e-demo/ })
  await expect(card).toBeVisible({ timeout: 90_000 })
  await expect(card.getByText("慢任务")).toBeVisible({ timeout: 60_000 })
  await expect(card).toContainText(/运行中/)
  await card.getByRole("button", { name: "取消工作流" }).click()
  await expect(card).toContainText(/已取消/, { timeout: 60_000 })
  release()
})
