import { readFile } from "node:fs/promises"
import { test, expect } from "./fixture"

test.use({
  script: {
    reply: ({ toolResults }) =>
      toolResults.length
        ? { text: "Plan saved" }
        : { tool: "plan_generate", args: { content: "# Plan\nReview the project.", expectedRevision: 0 } },
  },
})

test("a rejected plan save shows its code and request while preserving edits and blocking execution", async ({
  kit,
}) => {
  await kit.mode(/全面接管|Full takeover/)
  await kit.send("请先制定方案")
  await expect(kit.page.getByText("计划已生成", { exact: true })).toBeVisible()
  await kit.page.getByRole("button", { name: "查看计划", exact: true }).filter({ visible: true }).first().click()
  await kit.page.getByRole("button", { name: "编辑计划", exact: true }).click()
  const editor = kit.page.getByRole("code").first()
  await expect(editor).toContainText("Review the project")
  await editor.click()
  await kit.page.keyboard.press("ControlOrMeta+A")
  await kit.page.keyboard.type("# Plan\nRetain human edits.")
  let starts = 0
  let rejected = 0
  kit.page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/plan/start")) starts++
  })
  await kit.page.route(
    (url) => /\/session\/[^/]+\/plan$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "PUT") return route.continue()
      rejected++
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        headers: { "x-request-id": "req_plan_conflict" },
        body: JSON.stringify({ name: "PlanConflictError", code: "MRK-5009", data: { message: "Plan changed" } }),
      })
    },
  )
  await kit.panel().getByRole("tab", { name: "计划", exact: true }).click()
  await kit.page.getByRole("button", { name: "开始执行", exact: true }).filter({ visible: true }).first().click()
  await expect(kit.page.locator(".toasts")).toContainText("MRK-5009 · req_plan_conflict")
  await expect(kit.page.locator(".toasts")).toContainText("MRK-4020")
  expect(rejected).toBeGreaterThan(0)
  expect(starts).toBe(0)
  await kit
    .panel()
    .getByRole("tab", { name: /^Plan-/ })
    .click()
  await expect(editor).toContainText("Retain human edits")
})

test("a failed terminal stop shows its code and request and keeps the tab for retry", async ({ kit }) => {
  await kit.openPanel("terminal")
  const terminal = kit.panel().getByRole("region", { name: "终端", exact: true })
  await expect(terminal).toBeVisible()
  await terminal.click()
  await kit.page.keyboard.type(`node -e "require('fs').writeFileSync('stop-ready.txt','ready')"`)
  await kit.page.keyboard.press("Enter")
  await expect.poll(() => readFile(`${kit.project}/stop-ready.txt`, "utf8").catch(() => undefined)).toBe("ready")
  await kit.page.route(
    (url) => url.pathname === "/pty/close-owned",
    async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        headers: { "x-request-id": "req_terminal_stop" },
        body: JSON.stringify({
          name: "TerminalStopError",
          code: "MRK-5025",
          data: { message: "Terminal process exit could not be confirmed" },
        }),
      })
    },
  )
  try {
    await kit
      .panel()
      .getByRole("button", { name: /^关闭 终端/ })
      .click()
    await expect(kit.page.locator(".toasts")).toContainText("MRK-5025 · req_terminal_stop")
    await expect(kit.panel().getByRole("tab", { name: /^终端/ })).toHaveCount(1)
    await expect(kit.page.getByRole("button", { name: "复制详情（反馈问题时附上）", exact: true })).toBeVisible()
  } finally {
    await kit.page.unrouteAll({ behavior: "wait" })
  }
  await kit
    .panel()
    .getByRole("button", { name: /^关闭 终端/ })
    .click()
  await expect(kit.panel().getByRole("tab", { name: /^终端/ })).toHaveCount(0)
})
