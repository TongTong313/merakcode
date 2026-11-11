import { readFile } from "node:fs/promises"
import { test, expect } from "./fixture"

for (const entry of ["shortcut", "palette"])
  test(`opening a terminal from maximized review restores navigation using ${entry}`, async ({ kit }) => {
    await kit.openPanel("review")
    await kit.panel().getByRole("button", { name: "铺满", exact: true }).click()
    await expect(kit.panel().getByRole("button", { name: "还原", exact: true })).toBeVisible()
    if (entry === "shortcut") await kit.page.keyboard.press("ControlOrMeta+J")
    else {
      await kit.page.keyboard.press("ControlOrMeta+K")
      await kit.page.getByRole("option", { name: /终端/ }).click()
    }
    const terminal = kit.panel().getByRole("region", { name: "终端", exact: true })
    await expect(terminal).toBeVisible()
    await terminal.click()
    await kit.page.keyboard.type(`node -e "require('fs').writeFileSync('layout-ready.txt','ready')"`)
    await kit.page.keyboard.press("Enter")
    await expect.poll(() => readFile(`${kit.project}/layout-ready.txt`, "utf8").catch(() => undefined)).toBe("ready")
    await expect(kit.panel().getByRole("tablist")).toBeVisible()
    await expect(kit.panel().getByRole("button", { name: /^关闭 终端/ })).toBeVisible()
    await expect(kit.page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible()
    await kit.panel().getByRole("tab", { name: "审阅", exact: true }).click()
    await expect(kit.panel().getByRole("button", { name: "铺满", exact: true })).toBeVisible()
    await expect(kit.panel().getByRole("tab", { name: "审阅", exact: true })).toHaveCount(1)
    await kit.panel().getByRole("tab", { name: /^终端/ }).click()
    await terminal.click()
    await kit.page.keyboard.type(`node -e "require('fs').writeFileSync('layout-reused.txt','same terminal')"`)
    await kit.page.keyboard.press("Enter")
    await expect
      .poll(() => readFile(`${kit.project}/layout-reused.txt`, "utf8").catch(() => undefined))
      .toBe("same terminal")
  })
