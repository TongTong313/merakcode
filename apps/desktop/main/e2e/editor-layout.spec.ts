import { test, expect } from "./fixture"

test.use({
  config: {
    agentConnections: {
      products: { fake: { command: process.execPath, title: "Fake CLI", args: ["-e", "process.exit(0)"] } },
    },
  },
  script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) },
})

test("tab close buttons sit inside the tab and the add button stays at the right edge", async ({ kit }) => {
  await kit.openPanel("browser", true)
  await kit.openPanel("browser", true)
  const layout = async () => {
    const panel = kit.panel()
    const tab = (await panel.getByRole("tab", { name: "浏览器", exact: true }).boundingBox())!
    const close = (await panel.getByRole("button", { name: "关闭 浏览器", exact: true }).boundingBox())!
    const activeTab = (await panel.getByRole("tab", { name: "浏览器 · 2", exact: true }).boundingBox())!
    const activeClose = (await panel.getByRole("button", { name: "关闭 浏览器 · 2", exact: true }).boundingBox())!
    const add = (await panel.getByRole("button", { name: "新标签页", exact: true }).boundingBox())!
    const box = (await panel.boundingBox())!
    expect(close.x).toBeGreaterThanOrEqual(tab.x)
    expect(close.x + close.width).toBeLessThanOrEqual(tab.x + tab.width)
    expect(close.y).toBeGreaterThanOrEqual(tab.y)
    expect(close.y + close.height).toBeLessThanOrEqual(tab.y + tab.height)
    expect(activeClose.x).toBeGreaterThanOrEqual(activeTab.x)
    expect(activeClose.x + activeClose.width).toBeLessThanOrEqual(activeTab.x + activeTab.width)
    expect(add.x + add.width).toBeGreaterThanOrEqual(box.x + box.width - 16)
    await kit.page.mouse.move(5, 5)
    const opacity = (name: string) =>
      panel.getByRole("button", { name, exact: true }).evaluate((node) => getComputedStyle(node).opacity)
    await expect.poll(() => opacity("关闭 浏览器 · 2")).toBe("1")
    await expect.poll(() => opacity("关闭 浏览器")).toBe("0")
    await panel.getByRole("tab", { name: "浏览器", exact: true }).hover()
    await expect.poll(() => opacity("关闭 浏览器")).toBe("1")
    await kit.page.mouse.move(5, 5)
  }
  await layout()
  await kit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 900))
  await layout()
})

test("single and group conversations restore separate editor layouts", async ({ kit }) => {
  const verifySingletons = async () => {
    const names = { review: "审阅", git: "Git 管理", plan: "计划" } as const
    for (const kind of ["review", "git", "plan"] as const) {
      await kit.openPanel(kind)
      await kit.panel().getByRole("button", { name: "新标签页", exact: true }).click()
      await expect(kit.panel().getByRole("button", { name: names[kind], exact: true })).toHaveCount(0)
      await kit.page.keyboard.press("Escape")
    }
    for (const kind of ["review", "git", "plan"] as const) {
      const tab = kit.panel().getByRole("tab", { name: names[kind], exact: true })
      await expect(tab).toHaveCount(1)
      await tab.hover()
      await kit
        .panel()
        .getByRole("button", { name: `关闭 ${names[kind]}`, exact: true })
        .click()
      await kit.panel().getByRole("button", { name: "新标签页", exact: true }).click()
      await expect(kit.panel().getByRole("button", { name: names[kind], exact: true })).toBeVisible()
      await kit.page.keyboard.press("Escape")
    }
  }
  const { page } = kit
  await kit.send("single editor layout")
  await expect(kit.text("Reply: single editor layout")).toBeVisible()
  const single = new URL(page.url()).pathname
  await verifySingletons()
  await kit.openPanel("git")
  await page.getByRole("button", { name: "新建协作群", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "新建协作群", exact: true })
  await dialog.getByRole("button", { name: "添加成员", exact: true }).click()
  await dialog.getByRole("button", { name: /^产品/ }).click()
  await page.getByRole("option", { name: "Fake CLI", exact: true }).click()
  await dialog.getByRole("textbox", { name: "姓名", exact: true }).fill("Member")
  await dialog.getByRole("button", { name: "加入", exact: true }).click()
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  await expect(page.getByRole("complementary", { name: "群成员", exact: true })).toBeVisible()
  const group = new URL(page.url()).pathname
  await verifySingletons()
  await kit.openPanel("browser")
  await expect(kit.panel().getByRole("tab", { name: "浏览器", exact: true })).toBeVisible()
  await expect(kit.panel().getByRole("tab")).toHaveCount(1)
  await page.locator(`a[href="${single}"]`).click()
  await expect(kit.panel().getByRole("tab", { name: "Git 管理", exact: true })).toBeVisible()
  await expect(kit.panel().getByRole("tab")).toHaveCount(1)
  await page.locator(`a[href="${group}"]`).click()
  await page.reload()
  await expect(kit.panel().getByRole("tab", { name: "浏览器", exact: true })).toBeVisible()
  await expect(kit.panel().getByRole("tab")).toHaveCount(1)
})

test("overflow follows the restored strip after maximizing review and resizing", async ({ kit }) => {
  await kit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1800, 1000))
  for (let index = 0; index < 8; index++) await kit.openPanel("browser", true)
  await kit.openPanel("review")
  const resize = async (width: number) => {
    const handle = (await kit.panel().locator(".panel-resize").boundingBox())!
    await kit.page.mouse.move(handle.x + handle.width / 2, handle.y + 100)
    await kit.page.mouse.down()
    await kit.page.mouse.move(1800 - width, handle.y + 100)
    await kit.page.mouse.up()
  }
  await resize(1400)
  await expect(kit.panel().getByRole("button", { name: "全部标签", exact: true })).toHaveCount(0)
  await kit.panel().getByRole("button", { name: "铺满", exact: true }).click()
  await kit.page
    .getByRole("main", { name: "审阅", exact: true })
    .getByRole("button", { name: "返回对话", exact: true })
    .click()
  await resize(300)
  await kit.panel().getByRole("button", { name: "全部标签", exact: true }).click()
  const overview = kit.page.getByRole("dialog", { name: "全部标签", exact: true })
  await expect(overview).toBeVisible()
  await overview.getByRole("button", { name: "关闭 浏览器", exact: true }).click()
  await expect(overview.getByRole("button", { name: /^关闭 浏览器/ })).toHaveCount(7)
  await overview.getByRole("button", { name: "浏览器 · 2", exact: true }).click()
  await expect(overview).toBeHidden()
  await expect(kit.panel().getByRole("tab", { name: "浏览器 · 2", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await resize(1400)
  await expect(kit.panel().getByRole("button", { name: "全部标签", exact: true })).toHaveCount(0)
})

test("the chooser keeps wide two-column cards", async ({ kit }) => {
  const toggle = kit.page.getByRole("button", { name: "右侧面板", exact: true })
  if (!(await kit.panel().isVisible())) await toggle.click()
  await kit.panel().getByRole("button", { name: "新标签页", exact: true }).click()
  const cards = kit.panel().locator("[data-panel-kind]")
  await expect(cards).toHaveCount(6)
  const boxes = await Promise.all([0, 1, 2, 3].map((index) => cards.nth(index).boundingBox()))
  for (const box of boxes) {
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(72)
    expect(box!.width).toBeGreaterThan(box!.height)
  }
  expect(boxes[0]!.y).toBe(boxes[1]!.y)
  expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y)
  expect(boxes[2]!.y).toBe(boxes[3]!.y)
})
