import { test, expect } from "./fixture"

// Plan mode is read-only mode: once the plan is written, the model calls plan_exit to ask whether to switch back and
// start implementing
test.use({
  script: {
    reply: ({ toolResults }) => (toolResults.length ? { text: "PLAN_EXITED" } : { tool: "plan_exit", args: {} }),
  },
})

test("confirming the switch after a read-only plan returns the mode to ask", async ({ kit }) => {
  await kit.mode(/只读|Read-only/)
  await expect(kit.modeButton()).toContainText(/只读|Read-only/)
  await kit.send("方案写好了")
  const question = kit.page
    .getByText(/开始实施|start implementing/)
    .filter({ visible: true })
    .first()
  await expect(question).toBeVisible({ timeout: 60_000 })
  await kit.page
    .getByRole("button", { name: /^(同意|Yes)/ })
    .filter({ visible: true })
    .first()
    .click()
  await expect(kit.text("PLAN_EXITED")).toBeVisible({ timeout: 60_000 })
  await expect(kit.modeButton()).toContainText(/询问|Ask/)
})
