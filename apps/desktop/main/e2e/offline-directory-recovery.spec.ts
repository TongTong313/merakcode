import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"
import { test, expect } from "./fixture"

test.use({ git: true })

test("an offline saved directory leaves another checkout usable across reload and two restarts", async ({ kit }) => {
  test.skip(process.platform !== "win32", "SUBST reproduces an unavailable Windows volume")
  const drive = ["Y:", "Z:", "X:", "W:"].find((value) => !existsSync(`${value}\\`))
  expect(drive, "The fixture needs one unused temporary drive letter").toBeDefined()
  const volume = path.join(kit.root, "removable")
  await mkdir(path.join(volume, "old"), { recursive: true })
  await writeFile(path.join(volume, "old", "notes.txt"), "old baseline\n")
  const old = `${drive}\\old`
  const encoded = (value: string) => Buffer.from(value).toString("base64url")
  const healthyRoute = `/${encoded(kit.project)}/session`
  const oldRoute = `/${encoded(old)}/session`
  const origin = () => new URL(kit.page.url()).origin
  let mapped = false
  const connect = () => {
    execFileSync("subst.exe", [drive!, volume], { windowsHide: true })
    mapped = true
  }
  const disconnect = () => {
    execFileSync("subst.exe", [drive!, "/D"], { windowsHide: true })
    mapped = false
  }
  try {
    connect()
    await kit.page.goto(`${origin()}${oldRoute}`)
    await kit.openPanel("file")
    await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
    const editor = () => kit.panel().getByRole("code").first()
    await expect(editor()).toContainText("old baseline")
    await editor().click()
    await kit.page.keyboard.press("ControlOrMeta+A")
    await kit.page.keyboard.type("keep offline edits")
    const readStoredDrafts = () =>
      kit.page.evaluate(async () => {
        const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
        return Promise.all(
          (await bridge.storageBuckets())
            .filter((bucket) => bucket.startsWith("draft-"))
            .map((bucket) => bridge.storageEntries(bucket)),
        )
      })
    await expect.poll(async () => JSON.stringify(await readStoredDrafts())).toContain("keep offline edits")
    await kit.page.goto(`${origin()}${healthyRoute}`)
    disconnect()
    expect(existsSync(old)).toBe(false)
    kit.git("branch", "feature")
    await kit.page.reload()
    for (let restart = 0; restart <= 2; restart++) {
      if (restart) {
        const pid = kit.app.process().pid
        await kit.restart()
        expect(kit.app.process().pid).not.toBe(pid)
        await kit.page.goto(`${origin()}${healthyRoute}`)
      }
      await expect(kit.page.getByRole("button", { name: "右侧面板", exact: true })).toHaveAttribute(
        "aria-pressed",
        restart ? "true" : "false",
      )
      if (restart) await expect(kit.panel()).toBeVisible()
      await kit.openPanel("file")
      await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
      await expect(editor()).toContainText("hello from e2e")
      await kit.openPanel("git")
      await kit
        .panel()
        .getByRole("button", { name: /^当前分支/ })
        .click()
      await expect(kit.page.getByRole("option", { name: /^feature/ })).not.toHaveAttribute("aria-disabled", "true")
      await kit.page.keyboard.press("Escape")
      expect(JSON.stringify(await readStoredDrafts())).toContain("keep offline edits")
    }
    connect()
    await kit.page.goto(`${origin()}${oldRoute}`)
    await expect(editor()).toContainText("keep offline edits")
    expect(await readFile(path.join(volume, "old", "notes.txt"), "utf8")).toBe("old baseline\n")
    await kit.panel().getByRole("button", { name: "关闭 notes.txt", exact: true }).click()
    await kit.page.getByRole("dialog").getByRole("button", { name: /^放弃/ }).click()
    await kit.page.goto(`${origin()}${healthyRoute}`)
  } finally {
    if (mapped) disconnect()
  }
})
