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
    const config = path.join(kit.root, "config", "merakcode", "merakcode.json")
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
      .getByRole("button", { name: /^模型 / })
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
