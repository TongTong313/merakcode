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
  await kit.openPanel("git", true)
  await kit.openPanel("git", true)
  const adjacent = async () => {
    const close = (await kit.panel().getByRole("button", { name: "关闭 Git 管理", exact: true }).boundingBox())!
    const next = (await kit.panel().getByRole("tab", { name: "Git 管理 · 2", exact: true }).boundingBox())!
    const last = (await kit.panel().getByRole("button", { name: "关闭 Git 管理 · 2", exact: true }).boundingBox())!
    const add = (await kit.panel().getByRole("button", { name: "新标签页", exact: true }).boundingBox())!
    expect(next.x - close.x - close.width).toBeLessThan(12)
    expect(add.x - last.x - last.width).toBeLessThan(12)
  }
  await adjacent()
  await kit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 900))
  await adjacent()
})

test("single and group conversations restore separate editor layouts", async ({ kit }) => {
  const { page } = kit
  await kit.send("single editor layout")
  await expect(kit.text("Reply: single editor layout")).toBeVisible()
  const single = new URL(page.url()).pathname
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

test("overflow keeps every tab reachable and allows closing a hidden tab", async ({ kit }) => {
  for (let index = 0; index < 8; index++) await kit.openPanel("git", true)
  await kit.panel().getByRole("button", { name: "全部标签", exact: true }).click()
  const overview = kit.page.getByRole("dialog", { name: "全部标签", exact: true })
  await expect(overview).toBeVisible()
  await overview.getByRole("button", { name: "关闭 Git 管理", exact: true }).click()
  await expect(overview.getByRole("button", { name: /^关闭 Git 管理/ })).toHaveCount(7)
  await overview.getByRole("button", { name: "Git 管理 · 2", exact: true }).click()
  await expect(overview).toBeHidden()
  await expect(kit.panel().getByRole("tab", { name: "Git 管理 · 2", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
})
