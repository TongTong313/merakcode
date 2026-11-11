import { readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

test.use({ git: true, script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) } })

test("a terminal opened during first submission remains usable and survives reload and restart", async ({ kit }) => {
  await kit.openPanel("git")
  await kit.panel().getByRole("textbox", { name: "提交信息" }).fill("Keep the commit draft")
  await kit.app.evaluate(({ ipcMain }) => {
    const channel = "merakcode:invoke"
    const original = Reflect.get(ipcMain, "_invokeHandlers").get(channel)
    if (!original) throw new Error("Original bridge handler missing")
    const release = Promise.withResolvers<void>()
    const gate = {
      held: false,
      release: release.resolve,
      restore: () => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, original)
      },
    }
    Object.assign(globalThis, { migrationOpenGate: gate })
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, method, ...args) => {
      if (!gate.held && method === "storageSet" && args[0] === "panel-transfers") {
        gate.held = true
        await release.promise
      }
      return original(event, method, ...args)
    })
  })
  try {
    await kit.page.getByRole("textbox", { name: "消息", exact: true }).fill("migration shortcut")
    await kit.page.getByRole("button", { name: "发送", exact: true }).click()
    await expect.poll(() => kit.app.evaluate(() => Reflect.get(globalThis, "migrationOpenGate").held)).toBe(true)
    await expect(kit.panel()).toHaveAttribute("inert", "")
    expect(await kit.page.evaluate(() => document.documentElement.inert)).toBe(false)
    await kit.page.keyboard.press("ControlOrMeta+J")
    await kit.app.evaluate(() => Reflect.get(globalThis, "migrationOpenGate").release())
    await expect(kit.page).toHaveURL(/\/session\/ses_/)
    await expect(kit.text("Reply: migration shortcut")).toBeVisible()
    await expect(kit.panel().getByRole("tab", { name: /^终端/ })).toHaveCount(1)
    const marker = path.join(kit.project, "migration-terminal.txt")
    const script = path.join(kit.project, "migration-terminal.mjs")
    await writeFile(
      script,
      `import { realpathSync, writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, realpathSync(process.cwd()))`,
    )
    await kit.page.getByRole("region", { name: "终端", exact: true }).click()
    await kit.page.keyboard.type(`node "${script}"`)
    await kit.page.keyboard.press("Enter")
    await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe(await realpath(kit.project))
    const owner = new URL(kit.page.url()).pathname
    await kit.page.reload()
    await expect(kit.panel().getByRole("tab", { name: /^终端/ })).toHaveCount(1)
    await kit.panel().getByRole("tab", { name: "Git 管理", exact: true }).click()
    await expect(kit.panel().getByRole("textbox", { name: "提交信息" })).toHaveValue("Keep the commit draft")
    const previousPID = kit.app.process().pid
    await kit.restart()
    expect(kit.app.process().pid).not.toBe(previousPID)
    await kit.page.locator(`a[href="${owner}"]`).click()
    await expect(kit.panel().getByRole("tab", { name: /^终端/ })).toHaveCount(1)
    await expect(kit.panel().getByRole("textbox", { name: "提交信息" })).toHaveValue("Keep the commit draft")
    await kit.page
      .getByRole("navigation", { name: "对话" })
      .getByRole("button", { name: "新对话", exact: true })
      .click()
    await expect(kit.panel().getByRole("tab")).toHaveCount(0)
  } finally {
    await kit.app
      .evaluate(() => {
        const gate = Reflect.get(globalThis, "migrationOpenGate")
        gate?.release()
        gate?.restore()
      })
      .catch(() => {})
  }
})
