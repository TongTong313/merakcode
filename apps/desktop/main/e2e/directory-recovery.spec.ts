import { mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"
import { test, expect } from "./fixture"

test.use({ git: true, script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) } })

test("a deleted file restores one selected alias tab and its protected draft across two restarts", async ({ kit }) => {
  const actual = path.join(kit.project, "actual")
  const alias = path.join(kit.project, "alias")
  await mkdir(actual)
  await writeFile(path.join(actual, "removed.txt"), "original\n")
  await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir")
  expect(await realpath(alias)).toBe(await realpath(actual))
  await writeFile(path.join(kit.project, ".git", "info", "exclude"), "actual/\nalias\n", { flag: "a" })
  kit.git("branch", "feature")
  await kit.send("legacy alias owner")
  await expect(kit.text("Reply: legacy alias owner")).toBeVisible()
  const ownerURL = new URL(kit.page.url()).pathname
  const owner = ownerURL.split("/").at(-1)!
  const bucket = (prefix: string, value: string) => `${prefix}${Buffer.from(value).toString("base64url")}`
  const layout = bucket("panels-", owner)
  const drafts = bucket("draft-", kit.project)
  const links = bucket("file-links-", kit.project)
  await kit.page.evaluate(
    async ({ directory, owner, layout, drafts, links }) => {
      const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
      await bridge.storageSet(
        drafts,
        "actual/removed.txt",
        JSON.stringify({ version: 1, saved: "original\n", content: "Keep deleted file edits\n" }),
      )
      for (const path of ["actual/removed.txt", "alias/removed.txt"])
        await bridge.storageSet(links, path, JSON.stringify([owner]))
      await bridge.storageSet(
        layout,
        "layout",
        JSON.stringify({
          version: 1,
          directory,
          visible: true,
          selected: "selected-alias",
          tabs: [
            { id: "original-file", kind: "file", path: "actual/removed.txt", fileDirectory: directory },
            { id: "selected-alias", kind: "file", path: "alias/removed.txt", fileDirectory: directory },
          ],
        }),
      )
    },
    { directory: kit.project, owner, layout, drafts, links },
  )
  await unlink(path.join(actual, "removed.txt"))
  await kit.page.reload()
  for (let restart = 0; restart <= 2; restart++) {
    if (restart) {
      const previous = kit.app.process().pid
      await kit.restart()
      expect(kit.app.process().pid).not.toBe(previous)
      await kit.page.locator(`a[href="${ownerURL}"]`).click()
    }
    await expect(kit.panel().getByRole("tab", { name: /^removed\.txt/ })).toHaveCount(1)
    await kit
      .panel()
      .getByRole("tab", { name: /^removed\.txt/ })
      .click()
    await expect(kit.panel().getByRole("code").first()).toContainText("Keep deleted file edits")
    await expect(kit.panel().getByRole("status").filter({ hasText: "文件已删除，当前只读" })).toBeVisible()
    await expect
      .poll(() =>
        kit.page.evaluate(async (bucket) => {
          const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
          const saved = JSON.parse((await bridge.storageGet(bucket, "layout"))!)
          return { selected: saved.selected, files: saved.tabs.filter((tab: { kind: string }) => tab.kind === "file") }
        }, layout),
      )
      .toMatchObject({ selected: "selected-alias", files: [{ id: "selected-alias", path: "actual/removed.txt" }] })
    await expect
      .poll(() =>
        kit.page.evaluate(async (owner) => {
          const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
          const lists = await Promise.all(
            (await bridge.storageBuckets())
              .filter((bucket) => bucket.startsWith("file-links-"))
              .map(async (bucket) =>
                (await bridge.storageEntries(bucket)).flatMap(([key, value]) => {
                  const parsed = JSON.parse(value) as string[]
                  return parsed.includes(owner) ? [[key, parsed] as const] : []
                }),
              ),
          )
          return lists.flat()
        }, owner),
      )
      .toEqual([["actual/removed.txt", [owner]]])
    await kit.openPanel("git")
    await kit
      .panel()
      .getByRole("button", { name: /^当前分支/ })
      .click()
    await expect(kit.page.getByRole("option", { name: /^feature/ })).toHaveAttribute("aria-disabled", "true")
    await kit.page.keyboard.press("Escape")
  }
  // Close stays hidden until the tab is hovered. Git is the selected tab here.
  await kit
    .panel()
    .getByRole("tab", { name: /^removed\.txt/ })
    .hover()
  await kit.panel().getByRole("button", { name: "关闭 removed.txt", exact: true }).click()
  await kit.page.getByRole("dialog").getByRole("button", { name: /^放弃/ }).click()
  await expect(kit.page.getByRole("dialog")).toHaveCount(0)
  await kit
    .panel()
    .getByRole("button", { name: /^当前分支/ })
    .click()
  await expect(kit.page.getByRole("option", { name: /^feature/ })).not.toHaveAttribute("aria-disabled", "true")
  await expect(readFile(path.join(actual, "removed.txt"))).rejects.toMatchObject({ code: "ENOENT" })
})

for (const restart of [false, true])
  test(`a sleeping sibling directory draft protects its actual checkout after ${restart ? "restart" : "reload"}`, async ({
    kit,
  }) => {
    const alias = path.join(kit.root, "sibling-link")
    await symlink(kit.project, alias, process.platform === "win32" ? "junction" : "dir")
    expect(await realpath(alias)).toBe(await realpath(kit.project))
    const branch = kit.git("branch", "--show-current").trim()
    kit.git("branch", "feature")
    await kit.send("legacy owner")
    await expect(kit.text("Reply: legacy owner")).toBeVisible()
    const ownerURL = new URL(kit.page.url()).pathname
    const owner = ownerURL.split("/").at(-1)!
    await kit.page
      .getByRole("navigation", { name: "对话" })
      .getByRole("button", { name: "新对话", exact: true })
      .click()
    await kit.send("active conversation")
    await expect(kit.text("Reply: active conversation")).toBeVisible()
    const activeURL = new URL(kit.page.url()).pathname
    await kit.page.evaluate(
      async ({ alias, owner }) => {
        const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
        const encode = (value: string) =>
          btoa(unescape(encodeURIComponent(value)))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "")
        await bridge.storageSet(
          `draft-${encode(alias)}`,
          "notes.txt",
          JSON.stringify({ version: 1, saved: "hello from e2e\n", content: "legacy draft survives\n" }),
        )
        await bridge.storageSet(`file-links-${encode(alias)}`, "notes.txt", JSON.stringify([owner]))
        await bridge.storageSet(
          `panels-${encode(owner)}`,
          "layout",
          JSON.stringify({
            version: 1,
            directory: alias,
            visible: true,
            selected: "legacy-file",
            tabs: [{ id: "legacy-file", kind: "file", path: "notes.txt", fileDirectory: alias }],
          }),
        )
      },
      { alias, owner },
    )
    if (restart) {
      const previousPID = kit.app.process().pid
      await kit.restart()
      expect(kit.app.process().pid).not.toBe(previousPID)
      await kit.page.locator(`a[href="${activeURL}"]`).click()
    } else await kit.page.reload()
    await kit.openPanel("git")
    await kit
      .panel()
      .getByRole("button", { name: /^当前分支/ })
      .click()
    await expect(kit.page.getByRole("option", { name: /^feature/ })).toHaveAttribute("aria-disabled", "true")
    expect(kit.git("branch", "--show-current").trim()).toBe(branch)
    expect(await readFile(path.join(kit.project, "notes.txt"), "utf8")).toBe("hello from e2e\n")
    await kit.page.keyboard.press("Escape")
    await kit.page.locator(`a[href="${ownerURL}"]`).click()
    await expect(kit.panel().getByRole("code").first()).toContainText("legacy draft survives")
    await kit.panel().getByRole("button", { name: "关闭 notes.txt", exact: true }).click()
    await kit.page.getByRole("dialog").getByRole("button", { name: /^放弃/ }).click()
    await expect(kit.page.getByRole("dialog")).toHaveCount(0)
    await kit.page.locator(`a[href="${activeURL}"]`).click()
    await kit
      .panel()
      .getByRole("button", { name: /^当前分支/ })
      .click()
    const feature = kit.page.getByRole("option", { name: /^feature/ })
    await expect(feature).not.toHaveAttribute("aria-disabled", "true")
    await feature.click()
    await expect.poll(() => kit.git("branch", "--show-current").trim()).toBe("feature")
    expect(await readFile(path.join(kit.project, "notes.txt"), "utf8")).toBe("hello from e2e\n")
  })
