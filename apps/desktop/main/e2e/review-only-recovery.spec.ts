import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"
import { test, expect } from "./fixture"

let old = ""
let file = ""
test.use({
  git: true,
  script: {
    reply: ({ toolResults }) =>
      [
        { tool: "read_file", args: { path: file } },
        { tool: "write_file", args: { path: file, content: "reviewed change\n" } },
        { text: "Ready for feedback" },
      ][toolResults.length]!,
  },
})

for (const added of [false, true])
  test(`review-only ${added ? "comments" : "drafts"} on an offline volume leave other branches usable`, async ({
    kit,
  }) => {
    test.skip(process.platform !== "win32", "SUBST reproduces an unavailable Windows volume")
    const drive = ["Y:", "Z:", "X:", "W:"].find((value) => !existsSync(`${value}\\`))
    expect(drive).toBeDefined()
    const volume = path.join(kit.root, "review-volume")
    const physical = path.join(volume, "old")
    const disconnected = path.join(volume, "disconnected")
    file = path.join(physical, "notes.txt")
    await mkdir(physical, { recursive: true })
    await writeFile(path.join(physical, "notes.txt"), "old baseline\n")
    const git = (...args: string[]) => execFileSync("git", args, { cwd: physical, windowsHide: true }).toString().trim()
    git("init", "-q")
    git("config", "user.name", "Test")
    git("config", "user.email", "test@example.com")
    git("add", ".")
    git("commit", "-qm", "initial")
    old = `${drive}\\old`
    const encode = (value: string) => Buffer.from(value).toString("base64url")
    const healthyRoute = `/${encode(kit.project)}/session`
    const visit = (route: string) => kit.page.goto(`${new URL(kit.page.url()).origin}${route}`)
    let mapped = false
    let moved = false
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
      await visit(`/${encode(old)}/session`)
      await kit.mode(/全面接管|Full takeover/)
      await kit.send("Make a reviewable change")
      await expect(kit.text("Ready for feedback")).toBeVisible()
      const oldRoute = new URL(kit.page.url()).pathname
      const owner = oldRoute.split("/").at(-1)!
      await kit.page.getByRole("log").getByRole("button", { name: "审阅", exact: true }).click()
      await kit.panel().locator(".line.add .line-comment-add").first().click()
      await kit.panel().getByRole("textbox", { name: "评论", exact: true }).fill("keep review-only feedback")
      if (added) await kit.panel().getByRole("button", { name: "添加", exact: true }).click()
      const bucket = `panels-${encode(owner)}`
      const stored = () =>
        kit.page.evaluate(async (bucket) => {
          const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
          return { raw: await bridge.storageGet(bucket, "layout"), buckets: await bridge.storageBuckets() }
        }, bucket)
      await expect.poll(async () => (await stored()).raw).toContain("keep review-only feedback")
      await visit(healthyRoute)
      const before = await stored()
      expect(before.buckets.filter((bucket) => /^(draft-|file-links-)/.test(bucket))).toEqual([])
      const oldLayout = JSON.parse(before.raw!) as { tabs: { kind: string }[] }
      expect(oldLayout.tabs.every((tab) => tab.kind !== "file")).toBe(true)
      disconnect()
      kit.git("branch", "feature")
      const base = kit.git("branch", "--show-current").trim()
      await kit.restart(true)
      await visit(healthyRoute)
      const actual = await realpath(physical)
      const fixtureRoot = await realpath(kit.root)
      for (const destination of [actual, disconnected]) {
        // realpath(kit.root) can be the long path while the joined path still uses the 8.3 spelling.
        const parent = await realpath(path.dirname(destination))
        const full = path.join(parent, path.basename(destination))
        expect(path.relative(fixtureRoot, full)).not.toMatch(/^(?:\.\.(?:[\\/]|$)|[a-z]:)/i)
      }
      await rename(physical, disconnected)
      moved = true
      expect(existsSync(physical)).toBe(false)
      await kit.page.reload()
      for (let restart = 0; restart <= 2; restart++) {
        if (restart) {
          const pid = kit.app.process().pid
          await kit.restart(true)
          expect(kit.app.process().pid).not.toBe(pid)
          await visit(healthyRoute)
        }
        const target = restart === 1 ? base : "feature"
        await kit.page.getByRole("button", { name: /^当前分支/ }).click()
        await kit.page.getByRole("option", { name: new RegExp(`^${target}`) }).click()
        await expect.poll(() => kit.git("branch", "--show-current").trim()).toBe(target)
        expect((await stored()).raw).toBe(before.raw)
        if (restart === 1 && !added) {
          await kit.settings(/^(模型与供应商|Models & providers)$/)
          await kit.page.getByRole("button", { name: "模型配置", exact: true }).first().click()
          const dialog = kit.page.locator(".model-dialog")
          const toggle = dialog.getByRole("switch").first()
          const before = await toggle.getAttribute("aria-checked")
          await toggle.click()
          await expect(toggle).toHaveAttribute("aria-checked", before === "true" ? "false" : "true")
          await dialog.getByRole("button", { name: "恢复默认", exact: true }).click()
          await expect(toggle).toHaveAttribute("aria-checked", before!)
          await kit.page.keyboard.press("Escape")
          await kit.page.keyboard.press("Escape")
        }
        if (restart === 1)
          await kit.page.evaluate(
            async ({ old, actual }) => {
              const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
              for (const directory of [old, actual])
                await bridge.storageRemove("file-directories", directory.replace(/\\/g, "/"))
            },
            { old, actual },
          )
      }
      await rename(disconnected, physical)
      moved = false
      connect()
      await visit(oldRoute)
      if (added)
        await expect(
          kit.panel().getByText("keep review-only feedback", { exact: true }).filter({ visible: true }).first(),
        ).toBeVisible()
      else
        await expect(kit.panel().getByRole("textbox", { name: "评论", exact: true })).toHaveValue(
          "keep review-only feedback",
        )
      await visit(healthyRoute)
    } finally {
      if (moved) await rename(disconnected, physical)
      if (mapped) disconnect()
    }
  })
