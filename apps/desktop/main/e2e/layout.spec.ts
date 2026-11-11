import { test, expect } from "./fixture"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { connect } from "@merakcode/sdk"

test("the new conversation keeps the established reading width", async ({ kit }, info) => {
  await kit.page.screenshot({ path: info.outputPath("compose.png") })
  const width = await kit.page.locator(".composer").evaluate((element) => element.getBoundingClientRect().width)
  const available = await kit.page.locator(".compose-page").evaluate((element) => {
    const style = getComputedStyle(element)
    return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  })
  expect(width).toBeCloseTo(Math.min(720, available), 0)
})

test("settings and group views contain long content in a small window", async ({ kit }, info) => {
  await kit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 600))
  const endpoint = JSON.parse(await readFile(path.join(kit.root, "data", "engine.json"), "utf8"))
  const rpc = await connect(endpoint)
  const name = "Worker-" + "LongProjectName".repeat(8)
  try {
    const worker = (await rpc.agent.list({}))!.find((profile) => profile.role === "worker")!
    await rpc.agent.save({
      agent: { ...worker, id: "", name, model: { provider: "openai", model: "e2e" } },
    })
  } finally {
    await rpc.close()
  }
  const check = async (name: string) => {
    await kit.page.screenshot({ path: info.outputPath(`${name}.png`) })
    const overflow = await kit.page
      .locator(".settings-inner, .setting-row, .profile-card, .member-seat, .group-inbox, .dialog-head, .dialog-body")
      .evaluateAll((elements) =>
        elements
          .filter(
            (element) => element.getBoundingClientRect().width > 0 && element.scrollWidth > element.clientWidth + 1,
          )
          .map((element) => ({ name: element.className, extra: element.scrollWidth - element.clientWidth })),
      )
    expect.soft(overflow, name).toEqual([])
  }
  await kit.settings()
  for (const theme of ["light", "dark"] as const) {
    await kit.page.emulateMedia({ colorScheme: theme })
    for (const section of ["通用", "模型与供应商", "成员与档案", "云端账号", "关于与更新"]) {
      await kit.page
        .getByRole("navigation", { name: "设置", exact: true })
        .getByRole("button", { name: section, exact: true })
        .click()
      await expect(kit.page.getByRole("region", { name: section, exact: true })).toBeVisible()
      await check(`${theme}-${section}`)
    }
  }
  await kit.page.emulateMedia({ colorScheme: "light" })
  await kit.page.keyboard.press("Escape")
  await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
  const dialog = kit.page.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "群名称" }).fill("跨设备协作项目")
  await dialog.getByRole("checkbox", { name: `选择 ${name}`, exact: true }).check()
  await check("create-group")
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
  await check("group")
  await kit.page.getByRole("tab", { name: "收件箱", exact: true }).click()
  await check("inbox")
  await kit.page.getByRole("tab", { name: "用量与费用", exact: true }).click()
  await check("usage")
  await kit.page.getByRole("tab", { name: "任务看板", exact: true }).click()
  await kit.page.getByRole("button", { name: "新建任务", exact: true }).click()
  await dialog.getByRole("textbox", { name: "标题", exact: true }).fill(name)
  await dialog.getByRole("button", { name: "新建任务", exact: true }).click()
  await expect(dialog).toBeHidden()
  await kit.page.getByRole("button", { name, exact: true }).last().click()
  await check("task-dialog")
  await kit.page.keyboard.press("Escape")
  await kit.page.emulateMedia({ colorScheme: "dark" })
  await check("board-dark")
  await kit.page.getByRole("tab", { name: "群聊", exact: true }).click()
  await check("group-dark")
})

test.describe("long messages", () => {
  test.use({
    script: {
      reply: () => ({
        text: "```typescript\nconst location = '" + "path/".repeat(200) + "'\n```\n\nChecked the file.",
      }),
    },
  })
  test("long code scrolls inside the message without widening the conversation", async ({ kit }, info) => {
    await kit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 600))
    await kit.send("Inspect the file")
    await expect(kit.text("Checked the file.")).toBeVisible()
    await kit.page.screenshot({ path: info.outputPath("long-message.png") })
    const overflow = await kit.page
      .locator(".messages-inner, .turn, .assistant-message")
      .evaluateAll((elements) =>
        elements
          .filter((element) => element.getBoundingClientRect().width > element.closest(".chat-main")!.clientWidth + 1)
          .map((element) => element.className),
      )
    expect(overflow).toEqual([])
    await kit.page.locator(".assistant-message").hover()
    await expect(kit.page.locator(".assistant-message .message-actions")).toHaveCSS("opacity", "1")
  })
})

test.describe("long questions", () => {
  test.use({
    script: {
      reply: ({ toolResults }) =>
        toolResults.length
          ? { text: `ANSWER ${toolResults.at(-1)}` }
          : {
              tool: "ask_user",
              args: {
                text: "Select a delivery plan",
                options: Array.from({ length: 12 }, (_, i) => `Option ${i + 1}: ${"Detailed plan ".repeat(8)}`),
              },
            },
    },
  })
  test("keeps the question actions and composer inside a small window", async ({ kit }, info) => {
    await kit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 600))
    await kit.send("Ask me for a plan")
    const question = kit.page.locator(".approval.question")
    await expect(question).toBeVisible()
    const bounds = await question.boundingBox()
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.height).toBeLessThanOrEqual(300)
    await expect(kit.page.getByRole("button", { name: "提交", exact: true })).toBeInViewport()
    await expect(kit.page.locator(".composer")).toBeInViewport()
    await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+j" : "Control+j")
    await kit.page.locator(".dock .context-budget > summary").click()
    const submit = kit.page.getByRole("button", { name: "提交", exact: true })
    await submit.scrollIntoViewIfNeeded()
    const chat = await kit.page.locator(".chat-main").boundingBox()
    const actions = await submit.boundingBox()
    expect(actions!.y + actions!.height).toBeLessThanOrEqual(chat!.y + chat!.height + 1)
    await kit.page.locator(".composer").scrollIntoViewIfNeeded()
    const composer = await kit.page.locator(".composer").boundingBox()
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(chat!.y + chat!.height + 1)
    await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+j" : "Control+j")
    await question.getByRole("button", { name: /^Option 12:/ }).click()
    await kit.page.screenshot({ path: info.outputPath("question.png") })
    await kit.page.getByRole("button", { name: "提交", exact: true }).click()
    await expect(kit.text(/ANSWER Option 12:/)).toBeVisible()
  })
})

test("the member sidebar collapses to avatars and preserves its state", async ({ kit }, info) => {
  await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+g" : "Control+g")
  const dialog = kit.page.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "群名称" }).fill("协作项目")
  await dialog.getByRole("checkbox", { name: "选择 Worker", exact: true }).check()
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  const members = kit.page.getByRole("complementary", { name: "群成员" })
  await expect(members).toBeVisible()
  await expect
    .soft(kit.page.getByRole("region", { name: "project", exact: true }).getByRole("link", { name: /协作项目/ }))
    .toBeVisible({ timeout: 2000 })
  await expect
    .soft(members.getByRole("button", { name: "Worker", exact: true }))
    .toHaveAttribute("aria-expanded", "false", { timeout: 2000 })
  await members.getByRole("button", { name: "收起成员栏", exact: true }).click({ timeout: 2000 })
  expect((await members.boundingBox())!.width).toBe(52)
  await kit.page.reload()
  await expect(members.getByRole("button", { name: "展开成员栏", exact: true })).toBeVisible()
  await members.getByRole("button", { name: "Worker", exact: true }).click()
  await expect(members.getByRole("group", { name: "成员 Worker", exact: true })).toBeVisible()
  await expect(members.getByRole("button", { name: "Worker", exact: true })).toHaveAttribute("aria-expanded", "true")
  await expect(members.getByRole("button", { name: "向 Worker 发消息", exact: true })).toBeVisible()
  await expect(members.getByRole("button", { name: "向 Worker 发消息", exact: true })).toBeEnabled()
  await members.getByRole("button", { name: "沙箱状态", exact: true }).click()
  await expect(kit.page.getByRole("dialog", { name: "沙箱状态", exact: true })).toBeVisible()
  await kit.page.screenshot({ path: info.outputPath("sandbox.png") })
  await kit.page.keyboard.press("Escape")
  await members.locator("summary").filter({ hasText: "群设置" }).click()
  await expect(members.getByRole("combobox", { name: "主动程度" })).toBeVisible()
  await members.locator("summary").filter({ hasText: "群设置" }).click()
  await kit.page.screenshot({ path: info.outputPath("members.png") })
  await kit.page.getByRole("button", { name: "右侧面板", exact: true }).click()
  await expect(members.getByRole("button", { name: "展开成员栏", exact: true })).toBeVisible()
  await kit.panel().getByRole("button", { name: "铺满", exact: true }).click()
  await expect(kit.page.getByRole("navigation", { name: "对话", exact: true })).toBeHidden()
  await kit.page.getByRole("button", { name: "还原", exact: true }).click()
  await expect(kit.page.getByRole("navigation", { name: "对话", exact: true })).toBeVisible()
})

test.describe("panel layout", () => {
  test.use({ git: true })
  test("keeps each panel inside light and dark small windows", async ({ kit }, info) => {
    await kit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 600))
    await kit.page.getByRole("button", { name: "右侧面板", exact: true }).click()
    for (const theme of ["light", "dark"] as const) {
      await kit.page.emulateMedia({ colorScheme: theme })
      for (const tab of ["审阅", "Git 管理", "代码", "浏览器"]) {
        await kit.panel().getByRole("tab", { name: tab, exact: true }).click()
        if (tab === "代码") {
          await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
          await expect(kit.panel().locator(".monaco-editor")).toContainText("hello from e2e")
          const editor = await kit.panel().locator(".editor-host").boundingBox()
          expect.soft(editor!.width).toBeGreaterThanOrEqual(200)
          expect.soft(editor!.height).toBeGreaterThanOrEqual(150)
        }
        const overflow = await kit.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
        expect.soft(overflow, `${theme} ${tab}`).toBe(false)
        await kit.page.screenshot({ path: info.outputPath(`${theme}-${tab}.png`) })
      }
    }
    await kit.page.getByRole("button", { name: "右侧面板", exact: true }).click()
    await kit.page.keyboard.press("ControlOrMeta+J")
    await expect(kit.page.getByRole("region", { name: "终端", exact: true })).toBeVisible()
    await kit.page.screenshot({ path: info.outputPath("terminal-dark.png") })
  })
})
