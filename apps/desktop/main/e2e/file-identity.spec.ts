import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

test.use({ git: true })

test("opening a project subdirectory edits its file without touching the same name at the Git root", async ({
  kit,
}) => {
  const directory = path.join(kit.project, "sub")
  await mkdir(directory)
  await writeFile(path.join(directory, "notes.txt"), "subdirectory content\n")
  const origin = new URL(kit.page.url()).origin
  await kit.page.goto(`${origin}/${Buffer.from(directory).toString("base64url")}/session`)
  await kit.openPanel("git")
  await expect(kit.panel().getByRole("button", { name: /^当前分支/ })).toBeVisible()
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
  const editor = kit.panel().getByRole("code").first()
  await expect(editor).toContainText("subdirectory content")
  await editor.click()
  await kit.page.keyboard.press("ControlOrMeta+End")
  await kit.page.keyboard.type("subdirectory edit")
  await kit.page.keyboard.press("ControlOrMeta+S")
  await expect
    .poll(() => readFile(path.join(directory, "notes.txt"), "utf8"))
    .toBe("subdirectory content\nsubdirectory edit")
  expect(await readFile(path.join(kit.project, "notes.txt"), "utf8")).toBe("hello from e2e\n")
})
