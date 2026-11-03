import { test, expect } from "./fixture"

test.use({
  script: {
    reply: ({ prompt, toolResults, system }) => {
      if (/execute|执行/i.test(prompt))
        return {
          text: [system, prompt, ...toolResults].join("\n").includes("HUMAN_APPROVED_PLAN")
            ? "PLAN_EXECUTED_HUMAN"
            : "PLAN_EXECUTED_OLD",
        }
      if (toolResults.length === 0)
        return {
          tool: "plan_generate",
          args: { content: "# Plan\nInspect the project, then implement the requested change.", expectedRevision: 0 },
        }
      return { text: "PLAN_DRAFT_SAVED" }
    },
  },
})

test("a generated plan opens for review and starts execution without a second confirmation", async ({ kit }) => {
  await kit.mode(/完全接管|Full takeover/)
  await kit.send("请先制定方案")
  await expect(kit.page.getByText(/计划已生成|Plan generated/).first()).toBeVisible({ timeout: 60_000 })
  await kit.page
    .getByRole("button", { name: /查看计划|View plan/ })
    .filter({ visible: true })
    .first()
    .click()
  await expect(kit.panel().getByText("Inspect the project, then implement the requested change.")).toBeVisible()
  await kit.page.getByRole("button", { name: /编辑计划|Edit plan/ }).click()
  await expect(kit.page.getByRole("tab", { name: /\.md/ })).toBeVisible({ timeout: 60_000 })
  const editor = kit.page.getByRole("code")
  await expect(editor).toContainText("Inspect the project")
  await editor.click()
  await kit.page.keyboard.press("ControlOrMeta+A")
  await kit.page.keyboard.type("# Plan\nHUMAN_APPROVED_PLAN")
  await kit.page.keyboard.press("ControlOrMeta+S")
  await kit.page
    .getByRole("button", { name: /开始执行|Start execution/ })
    .filter({ visible: true })
    .first()
    .click()
  await expect(kit.text("PLAN_EXECUTED_HUMAN")).toBeVisible({ timeout: 60_000 })
  await expect(kit.modeButton()).toContainText(/完全接管|Full takeover/)
  expect(kit.modelRequests().some((request) => request.prompt.includes("HUMAN_APPROVED_PLAN"))).toBe(true)
  await expect(kit.page.locator(".plan-card")).toHaveCount(1)
  await expect(kit.page.locator(".plan-card").getByRole("button", { name: /开始执行|Start execution/ })).toBeDisabled()
})
