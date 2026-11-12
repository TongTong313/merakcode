import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

test.use({ git: true })

test("an open image refreshes after an external update and reports deletion", async ({ kit }) => {
  const original = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a3sAAAAASUVORK5CYII=",
    "base64",
  )
  const file = path.join(kit.project, "pixel.png")
  await writeFile(file, original)
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "pixel.png", exact: true }).click()
  const image = kit.panel().getByRole("img", { name: "pixel.png", exact: true })
  await expect(image).toBeVisible()
  const changed = Buffer.concat([original, Buffer.from("updated image version")])
  await writeFile(file, changed)
  await kit.page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(image).toHaveAttribute("src", `data:image/png;base64,${changed.toString("base64")}`)
  await unlink(file)
  await kit.page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(image).toHaveCount(0)
  await expect(kit.panel().getByRole("status").filter({ hasText: "文件已删除，当前只读" })).toBeVisible()
})

test("plain files open directly in the editor with a workspace tree and no view modes", async ({ kit }) => {
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
  await expect(kit.panel().getByRole("code")).toContainText("hello from e2e")
  await expect(kit.panel().getByRole("button", { name: /^(编辑|更改|文件)$/ })).toHaveCount(0)
  await expect(kit.panel().getByRole("tree", { name: "文件", exact: true })).toBeVisible()
})

test("opening an image previews it without exposing a text save", async ({ kit }) => {
  const rpc = await kit.rpc()
  const original = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a3sAAAAASUVORK5CYII=",
    "base64",
  )
  const file = path.join(kit.project, "pixel.png")
  await writeFile(file, original)
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "pixel.png", exact: true }).click()
  await expect(kit.panel().getByRole("img", { name: "pixel.png", exact: true })).toBeVisible()
  await expect(kit.panel().getByRole("code")).toHaveCount(0)
  await kit.page.keyboard.press("ControlOrMeta+S")
  expect(await readFile(file)).toEqual(original)
  expect(rpc.seen("file.write")).toEqual([])
})

test("an external write after a save remains protected by the next save conflict", async ({ kit }) => {
  const rpc = await kit.rpc()
  const file = path.join(kit.project, "notes.txt")
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
  const editor = kit.panel().getByRole("code").first()
  await expect(editor).toContainText("hello from e2e")
  await editor.click()
  await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
  await kit.page.keyboard.type("first local save")
  // Reads that follow the first save wait, so a reload cannot refresh the editor's idea of the file
  const reads = rpc.hold("file.read", { match: () => rpc.seen("file.write").length > 0 })
  try {
    await kit.page.keyboard.press("ControlOrMeta+S")
    await expect.poll(() => rpc.seen("file.write").length).toBe(1)
    await expect(kit.panel().getByRole("tab", { name: /^notes\.txt/ })).not.toContainText("●")
    await writeFile(file, "external content must survive\n")
    await editor.click()
    await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
    await kit.page.keyboard.type("second local change")
    await kit.page.keyboard.press("ControlOrMeta+S")
    await expect.poll(() => rpc.seen("file.write").length).toBe(2)
    await expect(kit.page.locator(".toasts")).toContainText("MRK-4029")
    expect(await readFile(file, "utf8")).toBe("external content must survive\n")
    await expect(editor).toContainText("second local change")
  } finally {
    reads.release()
  }
})

test("file changes appear in the chooser and unified tab, and deleted files preserve drafts without recreation", async ({
  kit,
}) => {
  const rpc = await kit.rpc()
  await mkdir(path.join(kit.project, "src"))
  const file = path.join(kit.project, "src/nested-state.txt")
  await writeFile(file, "original\n")
  kit.git("add", "src/nested-state.txt")
  kit.git("commit", "--quiet", "-m", "nested state fixture")
  await writeFile(file, "changed on disk\n")
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "src", exact: true }).click()
  const item = kit.panel().getByRole("treeitem", { name: /^nested-state\.txt/ })
  await expect(item).toContainText("M")
  await item.click()
  const tab = kit.panel().getByRole("tab", { name: /^nested-state\.txt/ })
  await expect(tab).toContainText("M")
  const editor = kit.panel().getByRole("code").first()
  await expect(editor).toContainText("changed on disk")
  await editor.click()
  await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
  await kit.page.keyboard.type("recoverable draft")
  await unlink(file)
  await kit.openPanel("git")
  await tab.click()
  await expect(kit.panel().getByRole("status").filter({ hasText: "文件已删除，当前只读" })).toBeVisible()
  await expect(tab).toContainText("D")
  await expect(editor).toContainText("recoverable draft")
  await kit.page.keyboard.press("ControlOrMeta+S")
  await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  expect(rpc.seen("file.write")).toEqual([])
})
