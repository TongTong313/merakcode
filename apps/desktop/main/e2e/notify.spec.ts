import { readFile } from "node:fs/promises"
import path from "node:path"
import { connect } from "@merakcode/sdk"
import { test, expect, type Kit } from "./fixture"

// System notifications while the window is in the background: turn finished, approval needed, question asked.
// Real system notifications are not observable, so they are recorded at the browser Notification API.

/** Makes the window act as if in the background and records notifications; returns a reader for the records */
async function background(kit: Kit) {
  await kit.page.evaluate(() => {
    const sent: { title: string; body?: string }[] = []
    const record = window as unknown as { __sent: typeof sent; __click?: () => void }
    record.__sent = sent
    document.hasFocus = () => false
    class Fake {
      static permission = "granted"
      static requestPermission = async () => "granted"
      onclick: (() => void) | null = null
      constructor(title: string, options?: { body?: string }) {
        sent.push({ title, body: options?.body })
        record.__click = () => this.onclick?.()
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { value: Fake, configurable: true })
  })
  return () => kit.page.evaluate(() => (window as unknown as { __sent: { title: string; body?: string }[] }).__sent)
}

test("notifies in the background when a turn finishes; clicking returns to the conversation", async ({ kit }) => {
  const sent = await background(kit)
  await kit.send("在后台")
  await expect.poll(async () => (await sent()).map((item) => item.title)).toEqual(["对话完成"])
  // Navigate elsewhere first (in-app navigation, no page reload)
  const url = kit.page.url()
  await kit.page.getByRole("button", { name: "新对话" }).filter({ visible: true }).first().click()
  await expect.poll(() => kit.page.url()).not.toBe(url)
  await kit.page.evaluate(() => (window as unknown as { __click: () => void }).__click())
  await expect.poll(() => kit.page.url()).toBe(url)
})

test.describe("approval needed", () => {
  test.use({
    script: {
      reply: ({ toolResults }) =>
        toolResults.length ? { text: "DONE" } : { tool: "bash", args: { command: 'node -e "console.log(1)"' } },
    },
  })

  test("notifies when approval is needed while the window is in the background", async ({ kit }) => {
    const sent = await background(kit)
    await kit.send("跑个命令")
    await expect(kit.approval()).toBeVisible()
    await expect.poll(async () => (await sent()).map((item) => item.title)).toEqual(["需要你审批"])
  })
})

test("suppresses a foreground completion before notifying for a later background completion", async ({ kit }) => {
  const sent = await background(kit)
  await kit.page.evaluate(() => {
    document.hasFocus = () => true
  })
  await kit.send("foreground")
  await expect(kit.text("OK")).toBeVisible()
  expect(await sent()).toEqual([])
  await kit.page.evaluate(() => {
    document.hasFocus = () => false
  })
  await kit.send("background")
  await expect.poll(async () => (await sent()).map((item) => item.title)).toEqual(["对话完成"])
})

/** The engine of the app, for the facts a person does not cause by clicking, such as a task a group finishes. */
async function engineOf(kit: Kit) {
  const info = JSON.parse(await readFile(path.join(kit.root, "data", "engine.json"), "utf8"))
  return connect(info)
}

/** Finishes tasks in the only group, so each one puts a "task finished" message in the inbox. */
async function finishTasks(kit: Kit, titles: string[]) {
  const rpc = await engineOf(kit)
  try {
    const [group] = (await rpc.group.list())!
    for (const title of titles) {
      const card = await rpc.task.create({ group: group!.id, title })
      await rpc.task.cancel({ task: card.id })
    }
  } finally {
    await rpc.close()
  }
}

test.describe("group inbox", () => {
  test.use({
    git: true,
    script: {
      // The Leader is woken by the answer in a new turn, whose message names the answered question
      reply: ({ toolResults, prompt }) =>
        toolResults.length || prompt.includes("question.answered")
          ? { tool: "say", args: { text: "Answer received." } }
          : { tool: "ask_human", args: { to: "local-human", text: "Choose a color", options: ["Blue", "Green"] } },
    },
  })

  test("opens the original group question from a background notification", async ({ kit }) => {
    await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
    const dialog = kit.page.getByRole("dialog")
    await dialog.getByRole("textbox", { name: "群名称" }).fill("通知协作")
    await dialog.getByRole("button", { name: "创建", exact: true }).click()
    await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
    const sent = await background(kit)
    await kit.send("Choose the color")
    await expect.poll(async () => (await sent()).filter((item) => item.title === "智能体在等你回答")).toHaveLength(1)
    await kit.page.getByRole("button", { name: "新对话", exact: true }).filter({ visible: true }).first().click()
    await kit.page.evaluate(() => (window as unknown as { __click: () => void }).__click())
    const question = kit.page.getByRole("region", { name: "提问", exact: true })
    await expect(question).toContainText("Choose a color")
    await question.getByRole("button", { name: "Blue", exact: true }).click()
    await question.getByRole("button", { name: "提交", exact: true }).click()
    await expect(kit.page.getByRole("region", { name: "收件箱", exact: true })).not.toContainText("Choose a color")
  })
})

test.describe("inbox toast", () => {
  test.use({ git: true, script: { reply: () => ({ tool: "say", args: { text: "Ready." } }) } })

  test("a new message pops up once in the corner, goes away by itself and leads to its task", async ({ kit }) => {
    await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
    const dialog = kit.page.getByRole("dialog")
    await dialog.getByRole("textbox", { name: "群名称" }).fill("弹窗协作")
    await dialog.getByRole("button", { name: "创建", exact: true }).click()
    await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
    await kit.page.evaluate(() => {
      document.hasFocus = () => true
    })
    await finishTasks(kit, ["弹窗任务"])
    const toast = kit.page.getByRole("status").getByText("弹窗协作: 弹窗任务", { exact: false })
    await expect(toast).toHaveCount(1)
    await expect(toast).toHaveCount(0, { timeout: 10_000 })
    await finishTasks(kit, ["点击任务"])
    await kit.page
      .getByRole("status")
      .getByRole("link", { name: /点击任务/ })
      .click()
    await expect(kit.page.getByRole("heading", { name: "点击任务", exact: true })).toBeVisible()
  })
})

test.describe("inbox tray state", () => {
  test.use({ git: true, script: { reply: () => ({ tool: "say", args: { text: "Ready." } }) } })

  test("merges informational read status across two windows and reloads", async ({ kit }) => {
    await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
    const dialog = kit.page.getByRole("dialog")
    await dialog.getByRole("textbox", { name: "群名称" }).fill("共享收件箱")
    await dialog.getByRole("button", { name: "创建", exact: true }).click()
    await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
    await finishTasks(kit, ["通知甲", "通知乙"])
    await kit.page.getByRole("link", { name: "首页", exact: true }).click()
    const opened = kit.app.waitForEvent("window")
    await kit.page.evaluate(() => window.__MERAKCODE_DESKTOP__!.openWindow())
    const other = await opened
    await other.goto(kit.page.url())
    const first = kit.page.getByRole("region", { name: "收件箱", exact: true })
    const second = other.getByRole("region", { name: "收件箱", exact: true })
    await expect(second.getByRole("button", { name: "标为已读", exact: true })).toHaveCount(2)
    await first.getByRole("article").filter({ hasText: "通知甲" }).getByRole("button", { name: "标为已读" }).click()
    await second.getByRole("article").filter({ hasText: "通知乙" }).getByRole("button", { name: "标为已读" }).click()
    await expect(first.getByText("已读", { exact: true })).toHaveCount(2)
    await expect(second.getByText("已读", { exact: true })).toHaveCount(2)
    await kit.page.reload()
    await other.reload()
    await expect(first.getByText("已读", { exact: true })).toHaveCount(2)
    await expect(second.getByText("已读", { exact: true })).toHaveCount(2)
  })

  test("clears an informational badge and keeps it read after reload", async ({ kit }) => {
    // Observe the native OS boundary while keeping the real tray and menu implementations.
    await kit.app.evaluate(({ Tray }) => {
      const observed = globalThis as unknown as { trayMenu?: Electron.Menu; trayImage?: string }
      const setMenu = Tray.prototype.setContextMenu
      Tray.prototype.setContextMenu = function (menu) {
        observed.trayMenu = menu ?? undefined
        return setMenu.call(this, menu)
      }
      const setImage = Tray.prototype.setImage
      Tray.prototype.setImage = function (image) {
        if (typeof image !== "string") observed.trayImage = image.toDataURL()
        return setImage.call(this, image)
      }
    })
    const labels = () =>
      kit.app.evaluate(() =>
        (globalThis as unknown as { trayMenu?: Electron.Menu }).trayMenu?.items.map((item) => item.label),
      )
    const image = () => kit.app.evaluate(() => (globalThis as unknown as { trayImage?: string }).trayImage)
    await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
    const dialog = kit.page.getByRole("dialog")
    await dialog.getByRole("textbox", { name: "群名称" }).fill("收件状态")
    await dialog.getByRole("button", { name: "创建", exact: true }).click()
    await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
    await expect.poll(labels).toContain("收件状态")
    await expect.poll(image).toBeTruthy()
    const plain = await image()
    await finishTasks(kit, ["检查通知"])
    await expect.poll(labels).toContain("● 收件状态")
    await expect.poll(image).not.toBe(plain)
    await kit.app.evaluate(() => {
      const item = (globalThis as unknown as { trayMenu: Electron.Menu }).trayMenu.items.find(
        (item) => item.label === "清除通知",
      )!
      item.click(undefined, undefined, {})
    })
    await expect.poll(labels).toContain("收件状态")
    await expect.poll(labels).not.toContain("清除通知")
    await expect.poll(image).toBe(plain)
    await kit.page.getByRole("link", { name: "首页", exact: true }).click()
    const information = kit.page.getByRole("region", { name: "收件箱", exact: true })
    await expect(information).toContainText("检查通知")
    await expect(information.getByText("已读", { exact: true })).toHaveCount(1)
    await kit.page.reload()
    await expect(information.getByText("已读", { exact: true })).toHaveCount(1)
    await expect(information.getByRole("button", { name: "标为已读", exact: true })).toHaveCount(0)
    await expect.poll(labels).not.toContain("清除通知")
  })
})
