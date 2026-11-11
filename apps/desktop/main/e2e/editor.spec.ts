import { readFile, writeFile, rename, access } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

test.use({ script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) } })

test("first submission preserves a file whose identity lookup finishes late, including after restart", async ({
  kit,
}) => {
  await kit.openPanel("file")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let held = false
  await kit.page.route(
    (url) => url.pathname === "/file/identity",
    async (route) => {
      if (held) return route.continue()
      held = true
      entered.resolve()
      await release.promise
      await route.continue()
    },
  )
  try {
    const response = kit.page.waitForResponse((response) => new URL(response.url()).pathname === "/file/identity")
    await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
    await entered.promise
    await kit.page.getByRole("textbox", { name: "消息", exact: true }).fill("late file open")
    await kit.page.getByRole("button", { name: "发送", exact: true }).click()
    await expect.poll(() => kit.modelRequests().some((request) => request.prompt === "late file open")).toBe(true)
    // The response also releases when first submission waits for the accepted file open.
    await Promise.race([kit.page.waitForURL(/\/session\/ses_/), new Promise((resolve) => setTimeout(resolve, 1000))])
    release.resolve()
    expect((await response).status()).toBe(200)
    await expect(kit.page).toHaveURL(/\/session\/ses_/)
    await expect(kit.text("Reply: late file open")).toBeVisible()
    await expect(kit.panel().getByRole("tab", { name: /^notes\.txt/ })).toHaveCount(1)
    await expect(kit.panel().getByRole("code").first()).toContainText("hello from e2e")
    const activeURL = new URL(kit.page.url()).pathname
    const previousPID = kit.app.process().pid
    await kit.restart()
    expect(kit.app.process().pid).not.toBe(previousPID)
    await kit.page.locator(`a[href="${activeURL}"]`).click()
    await expect(kit.panel().getByRole("tab", { name: /^notes\.txt/ })).toHaveCount(1)
    await expect(kit.panel().getByRole("code").first()).toContainText("hello from e2e")
  } finally {
    release.resolve()
  }
})

test("a spelling-only file alias keeps the existing editor and draft after reload", async ({ kit }) => {
  const original = path.join(kit.project, "notes.txt")
  const renamed = path.join(kit.project, "Notes.txt")
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
  const editor = () => kit.panel().getByRole("code").first()
  await expect(editor()).toContainText("hello from e2e")
  await editor().click()
  await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
  await kit.page.keyboard.type("keep alias draft")
  await rename(original, renamed)
  const aliases = await access(original).then(
    () => true,
    () => false,
  )
  test.skip(!aliases, "This volume treats the renamed spelling as a distinct path")
  await kit.openPanel("git")
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "Notes.txt", exact: true }).click()
  await expect(editor()).toContainText("keep alias draft")
  await expect(kit.panel().getByRole("tab")).toHaveCount(2)
  await kit.page.reload()
  await expect(editor()).toContainText("keep alias draft")
  await expect(kit.panel().getByRole("tab")).toHaveCount(2)
  expect(await readFile(renamed, "utf8")).toBe("hello from e2e\n")
})

test("cursor movement coalesces durable layout writes and restores its position", async ({ kit }) => {
  await writeFile(path.join(kit.project, "notes.txt"), "0123456789".repeat(20))
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
  const editor = kit.panel().getByRole("code").first()
  await expect(editor).toContainText("0123456789")
  await editor.click()
  await kit.page.keyboard.press("ControlOrMeta+Home")
  await kit.app.evaluate(() => {
    const fs = process.getBuiltinModule("fs")
    const { syncBuiltinESMExports } = process.getBuiltinModule("module")
    const original = fs.writeFileSync
    let count = 0
    fs.writeFileSync = (...args: Parameters<typeof original>) => {
      if (String(args[0]).includes("panels-")) count++
      return original(...args)
    }
    syncBuiltinESMExports()
    Object.assign(globalThis, {
      readLayoutWrites: () => count,
      restoreLayoutWrites: () => {
        fs.writeFileSync = original
        syncBuiltinESMExports()
      },
    })
  })
  try {
    for (let i = 0; i < 20; i++) await kit.page.keyboard.press("ArrowRight")
    const writes = () => kit.app.evaluate(() => Reflect.get(globalThis, "readLayoutWrites")() as number)
    await expect.poll(writes).toBeGreaterThan(0)
    expect(await writes()).toBeLessThanOrEqual(4)
    const cursor = kit.panel().locator(".editor-host .cursors-layer .cursor").first()
    const before = (await cursor.boundingBox())!
    await kit.page.reload()
    await expect(kit.panel().getByRole("code").first()).toContainText("0123456789")
    await expect.poll(async () => Math.abs((await cursor.boundingBox())!.x - before.x)).toBeLessThan(3)
  } finally {
    await kit.app.evaluate(() => Reflect.get(globalThis, "restoreLayoutWrites")())
  }
})

test("conversation tabs and unsaved file contents survive switching and reloading", async ({ kit }) => {
  const { page } = kit
  await kit.send("editor conversation A")
  await expect(kit.text("Reply: editor conversation A")).toBeVisible()
  const a = new URL(page.url()).pathname
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "notes.txt" }).click()
  const editor = () => kit.panel().getByRole("code").first()
  await expect(editor()).toContainText("hello from e2e")
  await editor().click()
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
  await page.keyboard.type("recover this draft")
  await page.getByRole("navigation", { name: "对话" }).getByRole("button", { name: "新对话", exact: true }).click()
  await kit.send("editor conversation B")
  await expect(kit.text("Reply: editor conversation B")).toBeVisible()
  const b = new URL(page.url()).pathname
  await kit.openPanel("git")
  await expect(kit.panel().getByRole("tab")).toHaveCount(1)
  await page.locator(`a[href="${a}"]`).click()
  await expect(editor()).toContainText("recover this draft")
  await expect(kit.panel().getByRole("tab")).toHaveCount(1)
  await page.reload()
  await expect(editor()).toContainText("recover this draft")
  expect(await readFile(path.join(kit.project, "notes.txt"), "utf8")).toBe("hello from e2e\n")
  await page.locator(`a[href="${b}"]`).click()
  await expect(kit.panel().getByRole("tab", { name: "Git 管理", exact: true })).toBeVisible()
  await expect(kit.panel().getByRole("tab")).toHaveCount(1)
})

test("closing an unsaved file can be cancelled and saving closes the unified file tab", async ({ kit }) => {
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "notes.txt" }).click()
  const editor = kit.panel().getByRole("code").first()
  await expect(editor).toContainText("hello from e2e")
  await editor.click()
  await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
  await kit.page.keyboard.type("saved on close")
  await kit.panel().getByRole("button", { name: "关闭 notes.txt", exact: true }).click()
  const dialog = kit.page.getByRole("dialog", { name: "放弃这个文件的未保存编辑？" })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "取消", exact: true }).click()
  await expect(editor).toContainText("saved on close")
  await kit.panel().getByRole("button", { name: "关闭 notes.txt", exact: true }).click()
  await dialog.getByRole("button", { name: "保存并关闭", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(kit.panel().getByRole("tab")).toHaveCount(0)
  expect(await readFile(path.join(kit.project, "notes.txt"), "utf8")).toContain("saved on close")
})

test("closing one conversation's file reference preserves another conversation's shared draft", async ({ kit }) => {
  await kit.send("shared draft A")
  await expect(kit.text("Reply: shared draft A")).toBeVisible()
  const a = new URL(kit.page.url()).pathname
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "notes.txt" }).click()
  const editor = () => kit.panel().getByRole("code").first()
  await expect(editor()).toContainText("hello from e2e")
  await kit.page.getByRole("navigation", { name: "对话" }).getByRole("button", { name: "新对话", exact: true }).click()
  await kit.send("shared draft B")
  await expect(kit.text("Reply: shared draft B")).toBeVisible()
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "notes.txt" }).click()
  await expect(editor()).toContainText("hello from e2e")
  await editor().click()
  await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
  await kit.page.keyboard.type("shared unsaved work")
  await expect(editor()).toContainText("shared unsaved work")
  await kit.panel().getByRole("button", { name: "关闭 notes.txt", exact: true }).click()
  await expect(kit.page.getByRole("dialog")).toHaveCount(0)
  await expect(kit.panel().getByRole("tab")).toHaveCount(0)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await kit.page.route(
    (url) => url.pathname === "/file/content",
    async (route) => {
      entered.resolve()
      await release.promise
      await route.continue()
    },
  )
  try {
    await kit.page.locator(`a[href="${a}"]`).click()
    await entered.promise
    await kit.panel().getByRole("button", { name: "关闭 notes.txt", exact: true }).click()
    const dialog = kit.page.getByRole("dialog", { name: "放弃这个文件的未保存编辑？" })
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: "取消", exact: true }).click()
  } finally {
    release.resolve()
  }
  await expect(editor()).toContainText("shared unsaved work")
})

test("switching panels during a save preserves the model until the SDK save finishes", async ({ kit }) => {
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "notes.txt" }).click()
  const editor = () => kit.panel().getByRole("code").first()
  await expect(editor()).toContainText("hello from e2e")
  await editor().click()
  await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
  await kit.page.keyboard.type("save across panel switch")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const errors: string[] = []
  kit.page.on("pageerror", (error) => errors.push(error.message))
  let held = false
  await kit.page.route(
    (url) => url.pathname === "/file/content",
    async (route) => {
      if (route.request().method() !== "PUT" || held) return route.continue()
      held = true
      entered.resolve()
      await release.promise
      await route.continue()
    },
  )
  try {
    await kit.page.keyboard.press("ControlOrMeta+S")
    await entered.promise
    await kit.openPanel("git")
    release.resolve()
    await kit.openPanel("file")
    await expect(editor()).toContainText("save across panel switch")
    await expect(kit.panel().getByRole("tab", { name: /^notes\.txt/ })).not.toContainText("●")
    expect(await readFile(path.join(kit.project, "notes.txt"), "utf8")).toContain("save across panel switch")
    expect(errors).toEqual([])
  } finally {
    release.resolve()
  }
})
