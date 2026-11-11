import { test, expect } from "./fixture"

test.use({
  script: {
    reply: async ({ prompt, toolResults, system, closed }) => {
      if (prompt === "按原计划再做一遍") {
        await closed
        return { text: "CANCELLED_RERUN" }
      }
      if (/execute|执行/i.test(prompt))
        return {
          text: [system, prompt, ...toolResults].join("\n").includes("HUMAN_APPROVED_PLAN")
            ? "PLAN_EXECUTED_HUMAN"
            : "PLAN_EXECUTED_OLD",
        }
      if (toolResults.length === 0)
        return {
          tool: "plan_generate",
          args: {
            content: prompt.includes("LONG_PLAN")
              ? "# Long plan\n\n" +
                Array.from({ length: 100 }, (_, i) => `## Step ${i + 1}\n\nCheck the result.\n\n`).join("") +
                "PLAN_END"
              : "# Plan\nInspect the project, then implement the requested change.",
            expectedRevision: 0,
          },
        }
      return { text: "PLAN_DRAFT_SAVED" }
    },
  },
})

test("a long plan scrolls to its last section while actions remain available", async ({ kit }, testInfo) => {
  await kit.mode(/全面接管|Full takeover/)
  await kit.send("LONG_PLAN")
  await kit.page
    .getByRole("button", { name: /查看计划|View plan/ })
    .filter({ visible: true })
    .first()
    .click()
  const panel = kit.panel()
  await expect(panel.getByRole("heading", { name: "Long plan" })).toBeVisible()
  await expect(panel.getByRole("button", { name: /编辑计划|Edit plan/ })).toBeVisible()
  await expect(panel.getByRole("button", { name: /开始执行|Start execution/ })).toBeVisible()
  const bounds = await panel.boundingBox()
  await kit.page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 200)
  for (let i = 0; i < 8; i++) await kit.page.mouse.wheel(0, 1600)
  await expect(panel.getByText("PLAN_END", { exact: true })).toBeInViewport()
  await expect(panel.getByRole("button", { name: /开始执行|Start execution/ })).toBeInViewport()
  await kit.page.screenshot({ path: testInfo.outputPath("plan-panel.png") })
})

test("a generated plan opens for review and starts execution without a second confirmation", async ({ kit }) => {
  await kit.mode(/全面接管|Full takeover/)
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
  await kit.panel().getByRole("tab", { name: "计划", exact: true }).click()
  await kit.page
    .getByRole("button", { name: /开始执行|Start execution/ })
    .filter({ visible: true })
    .first()
    .click()
  await expect(kit.text("PLAN_EXECUTED_HUMAN")).toBeVisible({ timeout: 60_000 })
  await expect(kit.modeButton()).toContainText(/全面接管|Full takeover/)
  expect(kit.modelRequests().some((request) => request.prompt.includes("HUMAN_APPROVED_PLAN"))).toBe(true)
  await expect(kit.page.locator(".plan-card")).toHaveCount(1)
  await expect(kit.page.locator(".plan-card").getByRole("button", { name: /开始执行|Start execution/ })).toBeDisabled()
  await kit.send("按原计划再做一遍")
  await expect.poll(() => kit.modelRequests().some((request) => request.prompt === "按原计划再做一遍")).toBe(true)
  await kit.page.getByRole("button", { name: /^(停止|Stop)$/ }).click()
  const retry = kit.page.locator(".plan-card").getByRole("button", { name: /开始执行|Start execution/ })
  await expect(retry).toBeEnabled()
  const previous = kit.modelRequests().length
  await retry.click()
  await expect
    .poll(() =>
      kit
        .modelRequests()
        .slice(previous)
        .some((request) => request.prompt.includes("Execute the latest saved session plan")),
    )
    .toBe(true)
  await expect(retry).toBeDisabled()
  await expect(kit.page.getByText("PLAN_EXECUTED_HUMAN", { exact: true }).filter({ visible: true })).toHaveCount(2)
})
