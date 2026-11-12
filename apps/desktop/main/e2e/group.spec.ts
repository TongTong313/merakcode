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
    const breakdown = () => kit.page.getByRole("region", { name: "任务拆解", exact: true })
    try {
      await expect(worker()).toContainText("忙碌")
      await expect(breakdown()).toContainText("@Worker 检查三个验收条件")
      await expect(breakdown()).toContainText("已检查全部三项。")
      await expect(kit.page.getByRole("log", { name: "群聊" })).not.toContainText("已检查第一项。")
      await kit.page.reload()
      await expect(worker()).toContainText("忙碌")
      await expect(breakdown()).toContainText("已检查全部三项。")
      await expect(kit.page.getByRole("combobox", { name: "讨论位置" })).toHaveCount(0)
      releaseWorker()
      await expect(worker()).toContainText("空闲")
      await expect(breakdown()).toContainText("已检查全部三项。")
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

test.describe("full duplex", () => {
  let release = () => {}
  test.use({
    git: true,
    script: {
      reply: async ({ prompt, closed }) => {
        if (prompt.includes("长时间思考")) {
          await Promise.race([new Promise<void>((resolve) => (release = resolve)), closed])
          return { tool: "say", args: { text: "不应出现。" } }
        }
        return { tool: "say", args: { text: "已恢复。" } }
      },
    },
  })

  test("the input stays open while the Leader works, a second message is marked, and the stop button ends the turn", async ({
    kit,
  }) => {
    await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
    const dialog = kit.page.getByRole("dialog")
    await dialog.getByRole("textbox", { name: "群名称" }).fill("双向协作")
    await dialog.getByRole("button", { name: "创建", exact: true }).click()
    const log = kit.page.getByRole("log", { name: "群聊" })
    await expect(log).toBeVisible()
    const leader = () => kit.page.getByRole("group", { name: "成员 Leader", exact: true })
    try {
      await kit.send("长时间思考")
      await expect(leader()).toContainText("忙碌")
      await expect(kit.page.getByRole("button", { name: "停止", exact: true })).toBeVisible()
      await expect(kit.page.getByRole("textbox", { name: "消息", exact: true })).toBeEnabled()
      await kit.send("补一句")
      await expect(log).toContainText(/已送达|处理中/)
      await expect(log).toContainText("已恢复。")
      await expect(leader()).toContainText("空闲")
      await kit.send("再长时间思考一次")
      await expect(leader()).toContainText("忙碌")
      await kit.page.getByRole("button", { name: "停止", exact: true }).click()
      await expect(leader()).toContainText("空闲")
      await expect(log).not.toContainText("不应出现。")
      await kit.send("继续")
      await expect(log.getByText("已恢复。", { exact: true })).toHaveCount(2)
    } finally {
      release()
    }
  })
})

test("a group has one Leader chosen among Leader agents, configures no model, and creating groups adds no agents", async ({
  kit,
}) => {
  const agents = async () => {
    await kit.page.getByRole("button", { name: "新建智能体", exact: true }).click()
    await kit.page.keyboard.press("Escape")
    return kit.page.getByRole("region", { name: "我的智能体", exact: true }).getByRole("article")
  }
  const first = await agents()
  await expect(first.first()).toBeVisible()
  const before = await first.count()
  await kit.page.getByRole("link", { name: "首页", exact: true }).click()
  for (const name of ["第一个群", "第二个群"]) {
    await kit.page.getByRole("navigation").getByRole("button", { name: "新建协作群", exact: true }).click()
    const dialog = kit.page.getByRole("dialog")
    await dialog.getByRole("textbox", { name: "群名称" }).fill(name)
    await expect(dialog.getByRole("button", { name: /^配置模型/ })).toHaveCount(0)
    await dialog.getByRole("button", { name: /^Leader/ }).click()
    await expect(kit.page.getByRole("option")).toHaveCount(1)
    await kit.page.getByRole("option").click()
    await dialog.getByRole("button", { name: "创建", exact: true }).click()
    await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
  }
  await expect(kit.page.getByRole("link", { name: "第一个群" })).toBeVisible()
  await expect(kit.page.getByRole("link", { name: "第二个群" })).toBeVisible()
  await expect(await agents()).toHaveCount(before)
})
