import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { test, expect } from "./fixture"

// Code and browser tabs in the side panel, and the bottom terminal

test("code: opens a working file without enabling edits", async ({ kit }) => {
  const panel = kit.panel()
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  await panel.getByRole("tab", { name: "代码" }).click()
  await panel.getByRole("treeitem", { name: "notes.txt" }).click()
  const editor = panel.locator(".monaco-editor")
  await expect(editor).toContainText("hello from e2e")
  await editor.click()
  await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
  await kit.page.keyboard.type("edited")
  expect(await readFile(path.join(kit.project, "notes.txt"), "utf8")).toBe("hello from e2e\n")
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
  await kit.page.keyboard.press("ControlOrMeta+J")
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
  await kit.page.keyboard.press("ControlOrMeta+J")
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

test("closing a project stops its terminal process and descendants", async ({ kit }) => {
  await kit.page.keyboard.press("ControlOrMeta+J")
  await kit.page.locator(".terminal-host:visible").click()
  await kit.page.keyboard.type(
    `node -e "require('fs').writeFileSync('term-pid.txt',String(process.pid));setInterval(()=>{},1000)"`,
  )
  await kit.page.keyboard.press("Enter")
  const pidFile = path.join(kit.project, "term-pid.txt")
  await expect.poll(() => readFile(pidFile, "utf8").catch(() => "")).toMatch(/^\d+$/)
  const pid = Number(await readFile(pidFile, "utf8"))
  await kit.page.getByRole("button", { name: "项目操作" }).click()
  await kit.page.getByRole("menuitem", { name: "从列表移除" }).click()
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      },
      { timeout: 10000 },
    )
    .toBe(false)
})

test("hiding and reopening a terminal preserves its shell and remembered height", async ({ kit }) => {
  await kit.page.keyboard.press("ControlOrMeta+J")
  const terminal = kit.page.getByRole("region", { name: "终端" })
  const command = async (text: string) => {
    await kit.page.locator(".terminal-host:visible").click()
    await kit.page.keyboard.type(text)
    await kit.page.keyboard.press("Enter")
  }
  await command("MERAK_REPLAY=kept")
  const edge = await terminal.locator(".terminal-resize").boundingBox()
  await kit.page.mouse.move(edge!.x + edge!.width / 2, edge!.y + 2)
  await kit.page.mouse.down()
  await kit.page.mouse.move(edge!.x + edge!.width / 2, edge!.y - 80, { steps: 5 })
  await kit.page.mouse.up()
  const height = await terminal.evaluate((element) => element.getBoundingClientRect().height)
  await kit.page.keyboard.press("ControlOrMeta+J")
  await expect(terminal).toHaveCount(0)
  await kit.page.keyboard.press("ControlOrMeta+J")
  await command(`printf '%s' "$MERAK_REPLAY" > replay.txt`)
  await expect.poll(() => readFile(path.join(kit.project, "replay.txt"), "utf8").catch(() => "")).toBe("kept")
  expect(await terminal.evaluate((element) => element.getBoundingClientRect().height)).toBe(height)
  await kit.page.reload()
  await kit.page.keyboard.press("ControlOrMeta+J")
  expect(await terminal.evaluate((element) => element.getBoundingClientRect().height)).toBe(height)
})
