import { test, expect } from "./fixture"

let releaseLeader = () => {}
test.use({
  git: true,
  script: {
    reply: async ({ prompt, closed }) => {
      if (prompt.includes("确认协作流程")) {
        await Promise.race([new Promise<void>((resolve) => (releaseLeader = resolve)), closed])
        return { tool: "say", args: { text: "协作流程已确认。" } }
      }
      return { tool: "say", args: { text: "群消息已收到。" } }
    },
  },
})

test("creates a local group and restores member activity and chat after reload", async ({ kit }, info) => {
  await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
  const dialog = kit.page.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "群名称" }).fill("本地协作")
  await dialog.getByRole("checkbox", { name: "选择 Worker", exact: true }).check()
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
  await expect(kit.page.getByRole("link", { name: "本地协作" })).toBeVisible()
  await kit.page
    .getByRole("complementary", { name: "群成员" })
    .getByRole("button", { name: "Leader", exact: true })
    .click()
  await kit.page.getByRole("button", { name: "向 Leader 发消息", exact: true }).click()
  await kit.send("确认协作流程")
  const leader = () => kit.page.getByRole("group", { name: "成员 Leader", exact: true })
  try {
    await expect(leader()).toContainText("忙碌")
    await kit.page.reload()
    await expect(leader()).toContainText("忙碌")
    releaseLeader()
    await expect(kit.text("协作流程已确认。")).toBeVisible()
    await expect(leader()).toContainText("空闲")
    await kit.page.reload()
    await expect(
      kit.page.getByRole("log", { name: "群聊" }).getByText("协作流程已确认。", { exact: true }),
    ).toHaveCount(1)
    await expect(leader()).toContainText("空闲")
    await kit.page.screenshot({ path: info.outputPath("group.png") })
  } finally {
    releaseLeader()
  }
})

test.describe("worker progress", () => {
  let releaseWorker = () => {}
  test.use({
    script: {
      reply: async ({ tools, toolResults, closed }) => {
        if (tools.includes("submit_report")) {
          if (toolResults.length === 0) return { tool: "report_progress", args: { summary: "已检查第一项。" } }
          if (toolResults.length === 1) return { tool: "report_progress", args: { summary: "已检查全部三项。" } }
          await Promise.race([new Promise<void>((resolve) => (releaseWorker = resolve)), closed])
          return { tool: "submit_report", args: { verdict: "done", summary: "三项检查全部通过。" } }
        }
        return { tool: "say", args: { text: "成员进度已记录。" } }
      },
    },
  })
  test("combines claim progress and shows the worker's current task", async ({ kit }, info) => {
    await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
    const dialog = kit.page.getByRole("dialog")
    await dialog.getByRole("textbox", { name: "群名称" }).fill("进度协作")
    await dialog.getByRole("checkbox", { name: "选择 Worker", exact: true }).check()
    await dialog.getByRole("button", { name: "创建", exact: true }).click()
    await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
    await kit.send("@Worker 检查三个验收条件")
    const worker = () => kit.page.getByRole("group", { name: "成员 Worker", exact: true })
    try {
      await expect(worker()).toContainText("忙碌")
      await worker().getByRole("button", { name: "Worker", exact: true }).click()
      await expect(worker().getByRole("button", { name: "@Worker 检查三个验收条件", exact: true })).toBeVisible()
      await expect(kit.text("已检查全部三项。")).toBeVisible()
      await expect(kit.page.getByRole("log", { name: "群聊" })).not.toContainText("已检查第一项。")
      await kit.page.reload()
      await expect(worker()).toContainText("忙碌")
      await worker().getByRole("button", { name: "Worker", exact: true }).click()
      await expect(kit.text("已检查全部三项。")).toBeVisible()
      await worker().getByRole("button", { name: "@Worker 检查三个验收条件", exact: true }).click()
      await expect(kit.page.getByRole("combobox", { name: "讨论位置" })).not.toHaveValue("")
      releaseWorker()
      await expect(worker()).toContainText("空闲")
    } finally {
      releaseWorker()
      if (info.status !== info.expectedStatus)
        await info.attach("model-requests", {
          body: JSON.stringify(kit.modelRequests()),
          contentType: "application/json",
        })
    }
  })
})
