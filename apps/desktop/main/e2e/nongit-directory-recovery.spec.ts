import { mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"
import { test, expect } from "./fixture"

test.use({ git: false, script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) } })

test("a non-Git root link retarget cannot move legacy edits into its new destination", async ({ kit }) => {
  const alias = path.join(kit.root, "retargeted-link")
  const replacement = path.join(kit.root, "replacement")
  await mkdir(replacement)
  await writeFile(path.join(replacement, "notes.txt"), "replacement baseline\n")
  await symlink(kit.project, alias, process.platform === "win32" ? "junction" : "dir")
  const route = `/${Buffer.from(alias).toString("base64url")}/session`
  await kit.page.goto(`${new URL(kit.page.url()).origin}${route}`)
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
  await expect(kit.panel().getByRole("code").first()).toContainText("hello from e2e")
  const draftBucket = `draft-${Buffer.from(alias).toString("base64url")}`
  const raw = JSON.stringify({ version: 1, content: "keep original edits", saved: "hello from e2e\n", identity: null })
  await kit.page.evaluate(
    async ({ alias, draftBucket, raw }) => {
      const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
      const encode = (value: string) =>
        btoa(unescape(encodeURIComponent(value)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "")
      const owner = `new:${alias}`
      await bridge.storageSet(draftBucket, "notes.txt", raw)
      await bridge.storageSet(`file-links-${encode(alias)}`, "notes.txt", JSON.stringify([owner]))
      await bridge.storageSet(
        `panels-${encode(owner)}`,
        "layout",
        JSON.stringify({
          version: 1,
          directory: alias,
          visible: true,
          selected: "legacy",
          tabs: [{ id: "legacy", kind: "file", path: "notes.txt", fileDirectory: alias }],
        }),
      )
    },
    { alias, draftBucket, raw },
  )
  await unlink(alias)
  await symlink(replacement, alias, process.platform === "win32" ? "junction" : "dir")
  await kit.restart(true)
  await kit.page.goto(`${new URL(kit.page.url()).origin}${route}`)
  await expect(kit.page.getByRole("alert").filter({ hasText: "MRK-" })).toContainText("MRK-5023")
  expect(
    await kit.page.evaluate(async (bucket) => {
      const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
      return bridge.storageGet(bucket, "notes.txt")
    }, draftBucket),
  ).toBe(raw)
  expect(await readFile(path.join(replacement, "notes.txt"), "utf8")).toBe("replacement baseline\n")
  expect(await readFile(path.join(kit.project, "notes.txt"), "utf8")).toBe("hello from e2e\n")
  await unlink(alias)
  await symlink(kit.project, alias, process.platform === "win32" ? "junction" : "dir")
  await kit.page.getByRole("button", { name: "重试", exact: true }).click()
  await expect(kit.panel().getByRole("code").first()).toContainText("keep original edits")
})

for (const transfer of [false, true])
  test(`non-Git root links recover ${transfer ? "a retired transfer" : "legacy drafts"} and sleeping owners after reload and two restarts`, async ({
    kit,
  }) => {
    const alias = path.join(kit.root, "plain-link")
    await symlink(kit.project, alias, process.platform === "win32" ? "junction" : "dir")
    const actual = await realpath(kit.project)
    expect(await realpath(alias)).toBe(actual)
    const origin = new URL(kit.page.url()).origin
    await kit.page.goto(`${origin}/${Buffer.from(alias).toString("base64url")}/session`)
    await kit.send("legacy owner")
    await expect(kit.text("Reply: legacy owner")).toBeVisible()
    const ownerURL = new URL(kit.page.url()).pathname
    const owner = ownerURL.split("/").at(-1)!
    await kit.page
      .getByRole("navigation", { name: "对话" })
      .getByRole("button", { name: "新对话", exact: true })
      .click()
    await kit.send("sleeping owner")
    await expect(kit.text("Reply: sleeping owner")).toBeVisible()
    const siblingURL = new URL(kit.page.url()).pathname
    const sibling = siblingURL.split("/").at(-1)!
    await kit.page.locator(`a[href="${ownerURL}"]`).click()
    await kit.page.evaluate(
      async ({ actual, alias, owner, sibling, transfer }) => {
        const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
        const encode = (value: string) =>
          btoa(unescape(encodeURIComponent(value)))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "")
        await bridge.storageSet(
          `draft-${encode(alias)}`,
          "notes.txt",
          JSON.stringify({ version: 1, saved: "hello from e2e\n", content: "legacy non-Git edits\n" }),
        )
        await bridge.storageSet(`file-links-${encode(alias)}`, "notes.txt", JSON.stringify([owner, sibling]))
        for (const sessionID of [owner, sibling])
          await bridge.storageSet(
            `panels-${encode(sessionID)}`,
            "layout",
            JSON.stringify({
              version: 1,
              directory: alias,
              visible: true,
              selected: "legacy-file",
              tabs: [{ id: "legacy-file", kind: "file", path: "notes.txt", fileDirectory: alias }],
            }),
          )
        if (transfer) {
          const source = `new:${alias}`
          const snapshot = {
            version: 1,
            directory: alias,
            visible: true,
            selected: "transferred-file",
            tabs: [{ id: "transferred-file", kind: "file", path: "notes.txt", fileDirectory: alias }],
          }
          await bridge.storageSet(
            `panels-${encode(source)}`,
            "layout",
            JSON.stringify({ version: 1, directory: alias, tabs: [] }),
          )
          await bridge.storageSet(
            `panels-${encode(owner)}`,
            "layout",
            JSON.stringify({
              ...snapshot,
              directory: actual,
              selected: "legacy-file",
              tabs: [{ id: "legacy-file", kind: "file", path: "notes.txt", fileDirectory: actual }],
            }),
          )
          await bridge.storageSet(
            "panel-transfers",
            owner,
            JSON.stringify({
              version: 1,
              sourceContext: { directory: alias },
              target: { directory: alias, sessionID: owner },
              snapshot,
            }),
          )
        }
      },
      { actual, alias, owner, sibling, transfer },
    )
    await kit.page.reload()
    for (let restart = 0; restart <= 2; restart++) {
      if (restart) {
        const previous = kit.app.process().pid
        await kit.restart()
        expect(kit.app.process().pid).not.toBe(previous)
        await kit.page.locator(`a[href="${ownerURL}"]`).click()
      }
      await expect(kit.panel().getByRole("tab", { name: /^notes\.txt/ })).toHaveCount(1)
      await expect(kit.panel().getByRole("code").first()).toContainText("legacy non-Git edits")
      await expect
        .poll(() =>
          kit.page.evaluate(
            async ({ actual, alias }) => {
              const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
              const encode = (value: string) =>
                btoa(unescape(encodeURIComponent(value)))
                  .replace(/\+/g, "-")
                  .replace(/\//g, "_")
                  .replace(/=+$/, "")
              return {
                owners: JSON.parse(
                  (await bridge.storageGet(`file-links-${encode(actual)}`, "notes.txt")) ?? "[]",
                ).sort(),
                oldDraft: await bridge.storageGet(`draft-${encode(alias)}`, "notes.txt"),
                oldOwners: await bridge.storageGet(`file-links-${encode(alias)}`, "notes.txt"),
                transfers: await bridge.storageEntries("panel-transfers"),
              }
            },
            { actual, alias },
          ),
        )
        .toEqual({ owners: [owner, sibling].sort(), oldDraft: null, oldOwners: null, transfers: [] })
      expect(await readFile(path.join(actual, "notes.txt"), "utf8")).toBe("hello from e2e\n")
    }
    await kit.panel().getByRole("button", { name: "关闭 notes.txt", exact: true }).click()
    await expect(kit.page.getByRole("dialog")).toHaveCount(0)
    await kit.page.locator(`a[href="${siblingURL}"]`).click()
    await expect(kit.panel().getByRole("code").first()).toContainText("legacy non-Git edits")
    await kit.panel().getByRole("button", { name: "关闭 notes.txt", exact: true }).click()
    await kit.page.getByRole("dialog").getByRole("button", { name: /^放弃/ }).click()
    await expect(kit.page.getByRole("dialog")).toHaveCount(0)
    expect(await readFile(path.join(actual, "notes.txt"), "utf8")).toBe("hello from e2e\n")
  })
