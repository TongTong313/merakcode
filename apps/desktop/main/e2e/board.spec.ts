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

test("creates a worker task and opens its live process and structured report", async ({ kit }, info) => {
  await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
  const dialog = kit.page.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "群名称" }).fill("报告协作")
  await dialog.getByRole("checkbox", { name: "选择 Worker", exact: true }).check()
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  await kit.page.getByRole("tab", { name: "任务看板", exact: true }).click()
  await kit.page.getByRole("button", { name: "新建任务", exact: true }).click()
  await dialog.getByRole("textbox", { name: "标题", exact: true }).fill("检查指南")
  await dialog.getByRole("textbox", { name: "描述", exact: true }).fill("检查所有示例。")
  await dialog.getByRole("textbox", { name: "验收标准", exact: true }).fill("示例完整\n链接可用")
  await dialog.getByRole("combobox", { name: "指定成员或队长", exact: true }).selectOption({ label: "Worker" })
  await dialog.getByRole("checkbox", { name: "需要审核", exact: true }).check()
  await dialog.getByRole("button", { name: "新建任务", exact: true }).click()
  await expect(dialog).toBeHidden()
  const running = kit.page.getByRole("region", { name: "执行中任务", exact: true })
  try {
    await expect(running).toContainText("Checking the guide.")
    await running.getByRole("button", { name: /检查指南/ }).click()
    await expect(dialog).toContainText("示例完整")
    await dialog.locator("summary").filter({ hasText: "执行过程" }).click()
    await dialog.getByRole("log").getByRole("button", { name: "report_progress report_progress", exact: true }).click()
    await expect(dialog.getByRole("log")).toContainText("Checking the guide.")
    release()
    const report = dialog.getByRole("region", { name: "成员报告", exact: true })
    await expect(report).toContainText("The guide matches both acceptance criteria.")
    await expect(report.getByRole("table", { name: "文件改动", exact: true })).toContainText("notes.txt")
    await expect(report).toContainText("check guide")
    await expect(report).toContainText("退出码 0")
    await expect(report).toContainText("Publish the guide?")
    await expect(report).toContainText("Review the examples.")
    await expect(report).toContainText("输入 26000 · 输出 200")
    await expect(report).toContainText("费用未知")
    await dialog.locator("summary").filter({ hasText: "执行过程" }).click()
    await kit.page.screenshot({ path: info.outputPath("task-report.png") })
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    await expect(kit.page.getByRole("region", { name: "待审核任务", exact: true })).toContainText("检查指南")
    await kit.page.getByRole("tab", { name: "收件箱", exact: true }).click()
    await kit.page
      .getByRole("region", { name: "要我做的", exact: true })
      .getByRole("button", { name: "检查指南" })
      .click()
    await expect(
      kit.page
        .getByRole("region", { name: "任务审核", exact: true })
        .getByRole("region", { name: "成员报告", exact: true }),
    ).toContainText("The guide matches both acceptance criteria.")
  } finally {
    release()
  }
})
