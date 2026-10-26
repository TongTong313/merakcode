import { readFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

// Model connection and config: custom providers, and the notice for invalid config

/** Parses JSONC after stripping whole-line comments */
const json = async (file: string) =>
  JSON.parse((await readFile(file, "utf8").catch(() => "{}")).replace(/^\s*\/\/.*$/gm, "")) as Record<string, any>

test.describe("custom provider", () => {
  test.use({
    script: { reply: ({ model }) => ({ text: model === "e2e-local" ? "LOCAL_MODEL_OK" : `OTHER_MODEL ${model}` }) },
  })

  test("an OpenAI-compatible URL and model ID can be chosen for chat; deleting removes it from config", async ({
    kit,
  }) => {
    const config = path.join(kit.root, "merakcode.json")
    const panel = kit.page.getByRole("region", { name: "模型与供应商" })
    await kit.settings(/^模型与供应商$/)
    await panel.getByRole("button", { name: "添加自定义供应商" }).click()
    const dialog = kit.page.getByRole("dialog", { name: "添加自定义供应商" })
    await dialog.getByRole("textbox", { name: "名称" }).fill("Local")
    await dialog.getByRole("textbox", { name: "接口地址" }).fill(kit.modelURL)
    await dialog.getByRole("textbox", { name: "模型 ID" }).fill("e2e-local")
    await dialog.getByRole("button", { name: "添加" }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(async () => (await json(config)).provider?.local?.options?.baseURL).toBe(kit.modelURL)

    await kit.page.keyboard.press("Escape")
    await kit.page
      .getByRole("button", { name: /^配置模型，/ })
      .filter({ visible: true })
      .first()
      .click()
    await kit.page.getByRole("option", { name: /e2e-local/ }).click()
    await kit.send("你好")
    await expect(kit.text("LOCAL_MODEL_OK")).toBeVisible()

    await kit.settings(/^模型与供应商$/)
    await panel.getByRole("button", { name: "删除 Local" }).click()
    await expect.poll(async () => (await json(config)).provider?.local).toBeUndefined()
  })
})

test("a relay group keeps the context length the station returned", async ({ kit }) => {
  const config = path.join(kit.root, "merakcode.json")
  const panel = kit.page.getByRole("region", { name: "模型与供应商" })
  await kit.settings(/^模型与供应商$/)
  await panel.getByRole("button", { name: "添加自定义供应商" }).click()
  const dialog = kit.page.getByRole("dialog", { name: "添加自定义供应商" })
  await dialog.getByRole("radio", { name: "中转站" }).click()
  await dialog.getByRole("textbox", { name: "名称" }).fill("Packy")
  await dialog.getByRole("textbox", { name: "接口地址" }).fill(kit.modelURL)
  await dialog.getByRole("textbox", { name: "API 密钥" }).fill("sk-e2e")
  await dialog.getByRole("radio", { name: /其他分组/ }).click()
  await dialog.getByRole("button", { name: "拉取模型" }).click()
  await expect(dialog.getByText("上下文窗口")).toBeVisible()
  await expect(dialog.getByText("输出上限")).toBeVisible()
  const context = dialog.getByRole("textbox", { name: "上下文窗口" })
  await expect(context).toHaveValue("32000")
  await expect(dialog.getByText("来自中转站")).toBeVisible()
  await context.fill("11111")
  await dialog.getByRole("button", { name: "添加" }).click()
  await expect(dialog).toBeHidden()
  await expect
    .poll(async () => (await json(config)).provider?.["packy-standard"]?.models?.["e2e-relay"]?.limit?.context)
    .toBe(11111)
  expect(JSON.stringify((await json(config)).provider?.["packy-standard"])).not.toContain("sk-e2e")
})

test("the custom provider dialog keeps one fixed frame across modes and groups", async ({ kit }) => {
  const panel = kit.page.getByRole("region", { name: "模型与供应商" })
  await kit.settings(/^模型与供应商$/)
  await panel.getByRole("button", { name: "添加自定义供应商" }).click()
  const dialog = kit.page.getByRole("dialog", { name: "添加自定义供应商" })
  const node = await dialog.elementHandle()
  if (!node) throw new Error("dialog missing")
  const frame = async () => {
    const box = await dialog.boundingBox()
    if (!box) throw new Error("dialog has no box")
    return { width: Math.round(box.width), height: Math.round(box.height) }
  }
  const same = () => dialog.evaluate((el, previous) => el === previous, node)
  const size = await frame()

  await dialog.getByRole("radio", { name: "中转站" }).click()
  expect(await same()).toBe(true)
  expect(await frame()).toEqual(size)
  await expect(dialog.getByRole("heading", { name: "添加自定义供应商" })).toBeInViewport()
  await expect(dialog.getByRole("button", { name: "取消" })).toBeInViewport()
  const name = await dialog.getByRole("textbox", { name: "名称" }).boundingBox()
  if (!name) throw new Error("name field missing")
  expect(Math.round(name.height)).toBe(32)

  await dialog.getByRole("radio", { name: /自定义分组/ }).click()
  expect(await frame()).toEqual(size)
  await expect(dialog.getByRole("textbox", { name: "附加请求头" })).toBeInViewport()
  await expect(dialog.getByRole("button", { name: "取消" })).toBeInViewport()

  await dialog.getByRole("radio", { name: "兼容接口" }).click()
  expect(await same()).toBe(true)
  expect(await frame()).toEqual(size)
  await expect(dialog.getByRole("textbox", { name: "模型 ID" })).toBeInViewport()
})

test("a long model list scrolls inside the custom provider dialog", async ({ kit }) => {
  const panel = kit.page.getByRole("region", { name: "模型与供应商" })
  await kit.settings(/^模型与供应商$/)
  await panel.getByRole("button", { name: "添加自定义供应商" }).click()
  const dialog = kit.page.getByRole("dialog", { name: "添加自定义供应商" })
  await dialog.getByRole("radio", { name: "中转站" }).click()
  await dialog.getByRole("textbox", { name: "名称" }).fill("Packy")
  await dialog.getByRole("textbox", { name: "接口地址" }).fill(kit.modelURL)
  await dialog.getByRole("textbox", { name: "API 密钥" }).fill("sk-e2e")
  await dialog.getByRole("button", { name: "拉取模型" }).click()
  await expect(dialog.getByText("来自中转站")).toBeVisible()

  const frame = async () => {
    const box = await dialog.boundingBox()
    if (!box) throw new Error("dialog has no box")
    return { width: Math.round(box.width), height: Math.round(box.height) }
  }
  const titleOffset = async () => {
    const dialogBox = await dialog.boundingBox()
    const titleBox = await dialog.getByRole("heading", { name: "添加自定义供应商" }).boundingBox()
    if (!dialogBox || !titleBox) throw new Error("title missing")
    return Math.round(titleBox.y - dialogBox.y)
  }
  const size = await frame()
  const title = await titleOffset()
  const manual = dialog.getByRole("textbox", { name: "手填模型 ID" })
  for (let i = 0; i < 20; i++) {
    await manual.fill(`extra-model-${i}`)
    await dialog.getByRole("button", { name: "加入" }).click()
  }
  await dialog.getByText("extra-model-19", { exact: true }).scrollIntoViewIfNeeded()
  await expect(dialog.getByText("extra-model-19", { exact: true })).toBeInViewport()
  await expect(dialog.getByText("e2e-relay")).not.toBeInViewport()
  await expect(dialog.getByText("上下文窗口")).toBeInViewport()
  await expect(dialog.getByText("输出上限")).toBeInViewport()
  expect(await frame()).toEqual(size)
  expect(await titleOffset()).toBe(title)
  await expect(dialog.getByRole("button", { name: "添加" })).toBeInViewport()

  await dialog.getByText("e2e-relay").scrollIntoViewIfNeeded()
  await expect(dialog.getByText("e2e-relay")).toBeInViewport()
  await expect(dialog.getByText("extra-model-19", { exact: true })).not.toBeInViewport()
  expect(await frame()).toEqual(size)
  expect(await titleOffset()).toBe(title)
  await expect(dialog.getByRole("heading", { name: "添加自定义供应商" })).toBeInViewport()
  await expect(dialog.getByRole("button", { name: "添加" })).toBeInViewport()
})

test.describe("invalid config", () => {
  // A local MCP server without a command: the engine skips the entry and starts normally
  test.use({ config: { mcp: { broken: { type: "local" } } } })

  test("startup reports how many entries were skipped; settings show the file and entry", async ({ kit }) => {
    await expect(kit.page.getByText(/配置里有 \d+ 处写法不对/)).toBeVisible()
    await kit.settings()
    const panel = kit.page.getByRole("region", { name: "通用" })
    await expect(panel.getByText(/mcp\.broken/).first()).toBeVisible()
  })
})
