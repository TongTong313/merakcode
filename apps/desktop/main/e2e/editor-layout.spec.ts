import { test, expect } from "./fixture"

test.use({
  config: {
    agentConnections: {
      products: { fake: { command: process.execPath, title: "Fake CLI", args: ["-e", "process.exit(0)"] } },
    },
  },
  script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) },
})

test("short tabs and the add button stay adjacent across panel widths", async ({ kit }) => {
  await kit.openPanel("browser", true)
  await kit.openPanel("browser", true)
  const adjacent = async () => {
    const close = (await kit.panel().getByRole("button", { name: "关闭 浏览器", exact: true }).boundingBox())!
    const next = (await kit.panel().getByRole("tab", { name: "浏览器 · 2", exact: true }).boundingBox())!
    const last = (await kit.panel().getByRole("button", { name: "关闭 浏览器 · 2", exact: true }).boundingBox())!
    const add = (await kit.panel().getByRole("button", { name: "新标签页", exact: true }).boundingBox())!
    expect(next.x - close.x - close.width).toBeLessThan(12)
    expect(add.x - last.x - last.width).toBeLessThan(12)
  }
  await adjacent()
  await kit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 900))
  await adjacent()
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
      await expect(kit.panel().getByRole("tab", { name: names[kind], exact: true })).toHaveCount(1)
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
