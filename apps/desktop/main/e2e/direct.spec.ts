import { readFile } from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"
import { connect } from "@merakcode/sdk"
import { test, expect, type Kit } from "./fixture"

// The external product is the Claude Code stand-in the fixture puts on PATH; with --echo it answers a message with
// "External reply: <message>", so every answer shows which message it belongs to.
async function addProduct(kit: Kit) {
  const engine = await connect(JSON.parse(await readFile(path.join(kit.root, "data", "engine.json"), "utf8")))
  try {
    await engine.agent.save({
      agent: {
        id: "",
        name: "Direct CLI",
        role: "worker",
        summary: "",
        duties: "",
        toolPool: "worker.default",
        shared: true,
        model: { provider: "", model: "" },
        product: { kind: "claude-code", binary: "claude", args: ["--echo"], model: "fixture-requested" },
      },
    })
  } finally {
    await engine.close()
  }
  // The window reads the agents when it starts
  await kit.page.reload()
  // Without a native model the start page asks to set one up first
  const input = kit.page.getByRole("textbox", { name: "消息", exact: true }).filter({ visible: true }).first()
  const skip = kit.page.getByRole("button", { name: "跳过", exact: true })
  await input.or(skip).first().waitFor()
  if (await skip.isVisible()) await skip.click()
  await input.waitFor()
}

async function selectExternal(page: Page) {
  await page.getByRole("button", { name: /^对话对象/ }).click()
  await page.getByRole("option", { name: /Direct CLI/ }).click()
}

// The page that turns the product of an agent on and off
async function switchProduct(kit: Kit) {
  const { page } = kit
  await page.getByRole("button", { name: "新建智能体", exact: true }).click()
  await page.keyboard.press("Escape")
  await page.getByRole("switch", { name: "启用 Direct CLI" }).click()
}

test.use({ claude: true })

test("creates and continues a direct external conversation through the existing new-chat page", async ({ kit }) => {
  const { page } = kit
  await addProduct(kit)
  await expect(page.getByRole("button", { name: /^对话对象/ })).toContainText("MerakCode")
  await selectExternal(page)
  const requests = kit.requests()
  await kit.send("first direct message")
  await expect(kit.text("External reply: first direct message")).toBeVisible()
  await expect(kit.text(/Direct CLI.*fixture-requested/)).toBeVisible()
  await expect(page.getByRole("link", { name: /first direct message/ })).toBeVisible()
  // The only request of the engine's own model is the title of the conversation
  await expect
    .poll(() => kit.modelRequests().slice(requests))
    .toEqual([
      {
        model: "e2e",
        system: expect.stringContaining("Write a title of at most 50 characters"),
        prompt: expect.stringContaining("first direct message"),
        tools: 0,
      },
    ])
  await kit.send("second direct message")
  await expect(kit.text("External reply: second direct message")).toBeVisible()
  expect(kit.requests()).toBe(requests + 1)
  expect(
    kit
      .modelRequests()
      .slice(requests)
      .every((request) => request.system.includes("Write a title of at most 50 characters")),
  ).toBe(true)
})

test("keeps a refused external chat locked after reconnect and restores its product when enabled", async ({ kit }) => {
  const { page } = kit
  await addProduct(kit)
  await selectExternal(page)
  await kit.send("before disable")
  await expect(kit.text("External reply: before disable")).toBeVisible()
  await switchProduct(kit)
  await page.getByRole("link", { name: /before disable/ }).click()
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
  await switchProduct(kit)
  await page.getByRole("link", { name: /before disable/ }).click()
  await expect(input).toBeEnabled()
  await kit.send("after enable")
  await expect(kit.text("External reply: after enable")).toBeVisible()
})

test("switches to MerakCode only after an explicit acceptance and keeps the external history", async ({ kit }) => {
  const { page } = kit
  await addProduct(kit)
  await selectExternal(page)
  await kit.send("retain this external reply")
  await expect(kit.text("External reply: retain this external reply")).toBeVisible()
  const originalURL = page.url()
  await switchProduct(kit)
  await page.getByRole("link", { name: /retain this external reply/ }).click()
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
  test.use({ config: { model: undefined, small_model: undefined, enabled_providers: undefined, provider: undefined } })

  test("can select and send to an external product before configuring a native model", async ({ kit }) => {
    await addProduct(kit)
    await selectExternal(kit.page)
    await expect(
      kit.page.getByRole("textbox", { name: "消息", exact: true }).filter({ visible: true }).first(),
    ).toBeEnabled()
    await kit.send("no native model needed")
    await expect(kit.text("External reply: no native model needed")).toBeVisible()
    expect(kit.requests()).toBe(0)
  })
})
