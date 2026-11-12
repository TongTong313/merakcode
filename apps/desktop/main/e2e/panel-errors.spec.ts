import { readFile } from "node:fs/promises"
import { test, expect } from "./fixture"

test.use({
  script: {
    reply: ({ toolResults }) =>
      toolResults.length
        ? { text: "Plan saved" }
        : { tool: "write_plan", args: { content: "# Plan\nReview the project." } },
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
  const rpc = await kit.rpc()
  rpc.fail("plan.save", "MRK-4011", { times: 10 })
  await kit.panel().getByRole("tab", { name: "计划", exact: true }).click()
  await kit.page.getByRole("button", { name: "开始执行", exact: true }).filter({ visible: true }).first().click()
  await expect(kit.page.locator(".toasts")).toContainText("MRK-4011")
  await expect(kit.page.locator(".toasts")).toContainText("MRK-4027")
  expect(rpc.seen("plan.save").length).toBeGreaterThan(0)
  expect(rpc.seen("plan.execute")).toEqual([])
  await kit
    .panel()
    .getByRole("tab", { name: /^Plan-/ })
    .click()
  await expect(editor).toContainText("Retain human edits")
})

test("a failed terminal stop shows its code and keeps the tab for retry", async ({ kit }) => {
  const rpc = await kit.rpc()
  await kit.openPanel("terminal")
  const terminal = kit.panel().getByRole("region", { name: "终端", exact: true })
  await expect(terminal).toBeVisible()
  await terminal.click()
  await kit.page.keyboard.type(`node -e "require('fs').writeFileSync('stop-ready.txt','ready')"`)
  await kit.page.keyboard.press("Enter")
  await expect.poll(() => readFile(`${kit.project}/stop-ready.txt`, "utf8").catch(() => undefined)).toBe("ready")
  rpc.fail("terminal.remove", "MRK-1003")
  await kit
    .panel()
    .getByRole("button", { name: /^关闭 终端/ })
    .click()
  await expect(kit.page.locator(".toasts")).toContainText("MRK-1003")
  await expect(kit.panel().getByRole("tab", { name: /^终端/ })).toHaveCount(1)
  await expect(kit.page.getByRole("button", { name: "复制详情（反馈问题时附上）", exact: true })).toBeVisible()
  await kit
    .panel()
    .getByRole("button", { name: /^关闭 终端/ })
    .click()
  await expect(kit.panel().getByRole("tab", { name: /^终端/ })).toHaveCount(0)
})
