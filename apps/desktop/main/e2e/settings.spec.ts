import { readFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

/** Parses JSONC after stripping whole-line comments */
const json = async (file: string) =>
  JSON.parse((await readFile(file, "utf8").catch(() => "{}")).replace(/^\s*\/\/.*$/gm, "")) as Record<string, any>

test("a permission rule added in settings is saved to project config and removed on delete", async ({ kit }) => {
  const config = path.join(kit.project, ".merakcode", "merakcode.json")
  await kit.settings(/^(权限与安全|Permissions & security)$/)
  const panel = kit.page.getByRole("region", { name: /^(权限与安全|Permissions & security)$/ })
  await expect(panel).toBeVisible()

  await panel.getByRole("textbox", { name: /^(规则匹配|Rule pattern)$/ }).fill("npm test *")
  await panel.getByRole("button", { name: /^(添加|Add)$/ }).click()
  await expect(panel).toContainText("npm test *")
  await expect.poll(async () => JSON.stringify((await json(config)).permission ?? {})).toContain("npm test *")

  await panel
    .getByRole("button", { name: /^(删除|Remove)$/ })
    .first()
    .click()
  await expect.poll(async () => JSON.stringify((await json(config)).permission ?? {})).not.toContain("npm test *")
})

test("switching to English in settings changes the UI and writes en-US to global config", async ({ kit }) => {
  const config = path.join(kit.root, "merakcode.json")
  await kit.settings()
  await kit.page
    .getByRole("button", { name: /^(语言|Language)/ })
    .filter({ visible: true })
    .first()
    .click()
  await kit.page
    .getByRole("option", { name: /English/ })
    .first()
    .click()
  await expect.poll(async () => (await json(config)).locale).toBe("en-US")
  await expect(kit.page.locator("html")).toHaveAttribute("lang", /^en/)
  await kit.page.keyboard.press("Escape")
  await expect(kit.page.getByRole("button", { name: "Settings" }).filter({ visible: true }).first()).toBeVisible()
})
