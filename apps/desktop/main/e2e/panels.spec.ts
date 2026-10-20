import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { test, expect } from "./fixture"

// Code and browser tabs in the side panel, and the bottom terminal

test("code: opens a file from the tree and saves edits to disk with Ctrl+S", async ({ kit }) => {
  const panel = kit.panel()
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  await panel.getByRole("tab", { name: "代码" }).click()
  await panel.getByRole("treeitem", { name: "notes.txt" }).click()
  const editor = panel.getByRole("code")
  await expect(editor).toContainText("hello from e2e")
  await editor.click()
  await kit.page.keyboard.press("Control+End")
  await kit.page.keyboard.type("edited")
  await kit.page.keyboard.press("Control+S")
  await expect.poll(() => readFile(path.join(kit.project, "notes.txt"), "utf8")).toBe("hello from e2e\nedited")
})

test("browser: opens a local page and shows its title and console errors", async ({ kit }) => {
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html><title>E2E 页面</title><h1>hi</h1><script>console.error("E2E_BOOM")</script>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  try {
    const panel = kit.panel()
    await kit.page.getByRole("button", { name: "右侧面板" }).click()
    await panel.getByRole("tab", { name: "浏览器" }).click()
    const address = panel.getByRole("textbox", { name: "地址" })
    await address.fill(`http://127.0.0.1:${port}/`)
    await address.press("Enter")
    await expect(panel.getByText("E2E 页面")).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByRole("region", { name: "控制台" })).toContainText("E2E_BOOM")
  } finally {
    server.close()
  }
})

test("terminal: opens with Ctrl+J and runs commands in the project directory", async ({ kit }) => {
  await kit.page.keyboard.press("Control+J")
  const terminal = kit.page.getByRole("region", { name: "终端" })
  await expect(terminal).toBeVisible()
  await terminal.click()
  await kit.page.keyboard.type(`node -e "require('fs').writeFileSync('term.txt','E2E_TERM')"`)
  await kit.page.keyboard.press("Enter")
  await expect
    .poll(() => readFile(path.join(kit.project, "term.txt"), "utf8").catch(() => ""), { timeout: 30_000 })
    .toBe("E2E_TERM")
})

test("multiple terminals run independently, switching back works, and closing one leaves one", async ({ kit }) => {
  const write = async (name: string) => {
    await kit.page.locator(".terminal-host:visible").click()
    await kit.page.keyboard.type(`node -e "require('fs').writeFileSync('${name}.txt','${name}')"`)
    await kit.page.keyboard.press("Enter")
    await expect
      .poll(() => readFile(path.join(kit.project, `${name}.txt`), "utf8").catch(() => ""), { timeout: 30_000 })
      .toBe(name)
  }
  await kit.page.keyboard.press("Control+J")
  const terminal = kit.page.getByRole("region", { name: "终端" })
  const tabs = terminal.getByRole("tab")
  await expect(tabs).toHaveCount(1)
  await write("one")

  await terminal.getByRole("button", { name: "新终端" }).click()
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true")
  await write("two")

  await tabs.nth(0).click()
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true")
  await write("three")

  await tabs.nth(1).getByRole("button", { name: /^关闭/ }).click()
  await expect(tabs).toHaveCount(1)
})
