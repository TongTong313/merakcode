import { test, expect } from "./fixture"

test.use({
  script: {
    reply: ({ prompt, toolResults, system }) => {
      if (/execute|执行/i.test(prompt))
        return { text: system.includes("HUMAN_APPROVED_PLAN") ? "PLAN_EXECUTED_HUMAN" : "PLAN_EXECUTED_OLD" }
      if (toolResults.length === 0)
        return {
          tool: "plan_write",
          args: { content: "# Plan\nInspect the project, then implement the requested change." },
        }
      return { tool: "plan_exit", args: {} }
    },
  },
})

test("a generated plan opens for review and starts execution without a second confirmation", async ({ kit }) => {
  await kit.mode(/计划|Plan/)
  await kit.send("请先制定方案")
  await expect(kit.page.getByText(/计划已生成|Plan generated/).first()).toBeVisible({ timeout: 60_000 })
  await kit.page
    .getByRole("button", { name: /查看计划|View plan/ })
    .filter({ visible: true })
    .first()
    .click()
  await expect(kit.page.getByRole("tab", { name: /\.md/ })).toBeVisible({ timeout: 60_000 })
  const editor = kit.page.getByRole("code")
  await expect(editor).toContainText("Inspect the project")
  await editor.click()
  await kit.page.keyboard.press("ControlOrMeta+A")
  await kit.page.keyboard.type("# Plan\nHUMAN_APPROVED_PLAN")
  await kit.page
    .getByRole("button", { name: /开始执行|Start execution/ })
    .filter({ visible: true })
    .first()
    .click()
  await expect(kit.text("PLAN_EXECUTED_HUMAN")).toBeVisible({ timeout: 60_000 })
  await expect(kit.modeButton()).toContainText(/执行|Execute/)
})
