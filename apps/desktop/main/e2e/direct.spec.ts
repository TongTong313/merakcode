import path from "node:path"
import type { Page } from "@playwright/test"
import { test, expect } from "./fixture"

const loader = new URL("../../../../script/node/register.mjs", import.meta.url).href
const product = {
  title: "Direct CLI",
  adapter: "member",
  command: process.execPath,
  args: [
    "--import",
    loader,
    "--disable-warning=ExperimentalWarning",
    path.join(import.meta.dirname, "fake-member.ts"),
    JSON.stringify({ streaming: {} }),
  ],
  model: { id: "fixture-requested" },
}

async function selectExternal(page: Page) {
  await page.getByRole("button", { name: /^对话对象/ }).click()
  await page.getByRole("option", { name: /Direct CLI/ }).click()
}

test.use({ config: { agentConnections: { products: { direct: product } } } })

test("creates and continues a direct external conversation through the existing new-chat page", async ({ kit }) => {
  const { page } = kit
  await expect(page.getByRole("button", { name: /^对话对象/ })).toContainText("MerakCode")
  await selectExternal(page)
  const requests = kit.requests()
  await kit.send("first direct message")
  await expect(kit.text("External reply: first direct message")).toBeVisible()
  await expect(kit.text(/Direct CLI.*fixture-selected/)).toBeVisible()
  await kit.send("second direct message")
  await expect(kit.text("External reply: second direct message")).toBeVisible()
  expect(kit.requests()).toBe(requests)
})

test("keeps a refused external chat locked after reconnect and restores its product when enabled", async ({ kit }) => {
  const { page } = kit
  await selectExternal(page)
  await kit.send("before disable")
  await expect(kit.text("External reply: before disable")).toBeVisible()
  await kit.settings(/智能体接入/)
  const panel = page.getByRole("region", { name: "智能体接入" })
  await panel.getByRole("switch", { name: "启用 Direct CLI" }).click()
  await page.getByRole("button", { name: "返回", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "对话产品已关闭" })
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  const input = page.getByRole("textbox", { name: "消息", exact: true }).filter({ visible: true }).first()
  await expect(input).toBeDisabled()
  await page.evaluate(() =>
    (window as unknown as { __MERAKCODE_DESKTOP__: { restartBackend(): void } }).__MERAKCODE_DESKTOP__.restartBackend(),
  )
  await page.reload()
  await expect(input).toBeDisabled()
  await expect(page.getByRole("dialog", { name: "对话产品已关闭" })).toHaveCount(0)
  await expect(kit.text("产品已关闭，输入已锁定。")).toBeVisible()
  await kit.settings(/智能体接入/)
  await panel.getByRole("switch", { name: "启用 Direct CLI" }).click()
  await page.getByRole("button", { name: "返回", exact: true }).click()
  await expect(input).toBeEnabled()
  await kit.send("after enable")
  await expect(kit.text("External reply: after enable")).toBeVisible()
})

test("switches to MerakCode only after an explicit acceptance and keeps the external history", async ({ kit }) => {
  const { page } = kit
  await selectExternal(page)
  await kit.send("retain this external reply")
  await expect(kit.text("External reply: retain this external reply")).toBeVisible()
  const originalURL = page.url()
  await kit.settings(/智能体接入/)
  await page.getByRole("region", { name: "智能体接入" }).getByRole("switch", { name: "启用 Direct CLI" }).click()
  await page.getByRole("button", { name: "返回", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "对话产品已关闭" })
  await dialog.getByRole("button", { name: "暂不接管" }).click()
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }).filter({ visible: true }).first(),
  ).toBeDisabled()
  await page.getByRole("button", { name: "由 MerakCode 接管", exact: true }).click()
  await dialog.getByRole("button", { name: "由 MerakCode 接管", exact: true }).click()
  await expect(kit.text("已由 MerakCode 接管，历史消息已保留。")).toBeVisible()
  await expect(page).toHaveURL(originalURL)
  await expect(kit.text("External reply: retain this external reply")).toBeVisible()
  const nativeRequests = kit.requests()
  await kit.send("continue with MerakCode")
  await expect(kit.text("OK")).toBeVisible()
  expect(kit.requests()).toBeGreaterThan(nativeRequests)
})

test.describe("without a native provider", () => {
  test.use({ config: { enabled_providers: [], agentConnections: { products: { direct: product } } } })

  test("can select and send to an external product before configuring a native model", async ({ kit }) => {
    await selectExternal(kit.page)
    await expect(
      kit.page.getByRole("textbox", { name: "消息", exact: true }).filter({ visible: true }).first(),
    ).toBeEnabled()
    await kit.send("no native model needed")
    await expect(kit.text("External reply: no native model needed")).toBeVisible()
    expect(kit.requests()).toBe(0)
  })
})
