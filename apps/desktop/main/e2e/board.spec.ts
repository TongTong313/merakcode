import { test, expect } from "./fixture"

let release = () => {}
test.use({
  git: true,
  script: {
    reply: async ({ tools, toolResults, closed }) => {
      if (!tools.includes("submit_report")) return { tool: "say", args: { text: "Ready for review." } }
      if (!toolResults.length) return { tool: "report_progress", args: { summary: "Checking the guide." } }
      await Promise.race([new Promise<void>((resolve) => (release = resolve)), closed])
      return {
        tool: "submit_report",
        args: {
          verdict: "done",
          summary: "The guide matches both acceptance criteria.",
          changes: [{ path: "notes.txt", kind: "modified", added: 2, removed: 1 }],
          checks: [{ command: "check guide", exitCode: 0 }],
          questions: ["Publish the guide?"],
          next: ["Review the examples."],
        },
      }
    },
  },
})

test("creates a task, gives it to a group, assigns a worker and opens its live process and structured report", async ({
  kit,
}, info) => {
  await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
  const dialog = kit.page.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "群名称" }).fill("报告协作")
  await dialog.getByRole("checkbox", { name: "选择 MerakCode", exact: true }).check()
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
  await kit.page.getByRole("button", { name: "新建任务", exact: true }).click()
  await dialog.getByRole("textbox", { name: "标题", exact: true }).fill("检查指南")
  await dialog.getByRole("textbox", { name: "描述", exact: true }).fill("检查所有示例。")
  await dialog.getByRole("textbox", { name: "验收标准", exact: true }).fill("示例完整\n链接可用")
  await expect(dialog.getByRole("switch", { name: "需要审核", exact: true })).toBeChecked()
  await dialog.getByRole("button", { name: "创建任务", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(kit.page.getByRole("heading", { name: "检查指南", exact: true })).toBeVisible()
  await expect(kit.page.getByText("任务要交给协作群才会开始", { exact: true }).first()).toBeVisible()
  await expect(kit.page.getByText("示例完整")).toBeVisible()
  await kit.page.getByRole("button", { name: "选择协作群", exact: true }).click()
  await dialog.getByRole("article").filter({ hasText: "报告协作" }).getByRole("button", { name: "选这个" }).click()
  await expect(kit.page.getByText("任务要交给协作群才会开始", { exact: true })).toHaveCount(0)
  await expect(kit.page.getByRole("button", { name: "报告协作", exact: true })).toBeVisible()
  await kit.page.getByRole("button", { name: /^指派成员 .+/ }).click()
  await kit.page.getByRole("option", { name: "MerakCode2", exact: true }).click()
  await kit.page.getByRole("button", { name: "指派成员", exact: true }).click()
  try {
    await expect(kit.page.getByText("Checking the guide.", { exact: true })).toBeVisible()
    await expect(kit.page.getByText("MerakCode2 负责")).toBeVisible()
    await kit.page.locator("summary").filter({ hasText: "执行过程" }).click()
    await kit.page
      .getByRole("log")
      .getByRole("button", { name: "report_progress report_progress", exact: true })
      .click()
    await expect(kit.page.getByRole("log")).toContainText("Checking the guide.")
    release()
    const report = kit.page.getByRole("region", { name: "成员报告", exact: true })
    await expect(report).toContainText("The guide matches both acceptance criteria.")
    await expect(report.getByRole("table", { name: "文件改动", exact: true })).toContainText("notes.txt")
    await expect(report).toContainText("check guide")
    await expect(report).toContainText("退出码 0")
    await expect(report).toContainText("Publish the guide?")
    await expect(report).toContainText("Review the examples.")
    await expect(report).toContainText("输入 26000 · 输出 200")
    await expect(report).toContainText("费用未知")
    await kit.page.screenshot({ path: info.outputPath("task-report.png") })
    await kit.page.getByRole("link", { name: "首页", exact: true }).click()
    await kit.page.getByRole("button", { name: "展开", exact: true }).click()
    await expect(kit.page.getByRole("region", { name: "待审核", exact: true })).toContainText("检查指南")
    await kit.page.getByRole("link", { name: "首页", exact: true }).click()
    await kit.page
      .getByRole("article")
      .filter({ hasText: "检查指南" })
      .getByRole("button", { name: "去处理", exact: true })
      .click()
    await kit.page.getByRole("button", { name: "审核任务", exact: true }).click()
    await expect(
      kit.page
        .getByRole("region", { name: "任务审核", exact: true })
        .getByRole("region", { name: "成员报告", exact: true }),
    ).toContainText("The guide matches both acceptance criteria.")
  } finally {
    release()
  }
})
