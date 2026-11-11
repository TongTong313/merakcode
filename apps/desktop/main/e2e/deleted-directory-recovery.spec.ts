import { readFile, realpath, symlink, unlink } from "node:fs/promises"
import path from "node:path"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"
import { test, expect } from "./fixture"

test.use({ git: false })

for (const legacyMapping of [false, true])
  test(`a deleted root link recovers its drafts and owners with legacy mapping=${legacyMapping}`, async ({ kit }) => {
    const alias = path.join(kit.root, "deleted-root-link")
    const encode = (value: string) => Buffer.from(value).toString("base64url")
    const owner = `new:${alias}`
    const draftBucket = `draft-${encode(alias)}`
    const refsBucket = `file-links-${encode(alias)}`
    const raw = JSON.stringify({
      version: 1,
      content: "legacy recovered edits",
      saved: "hello from e2e\n",
      identity: null,
    })
    await symlink(kit.project, alias, process.platform === "win32" ? "junction" : "dir")
    expect(await realpath(alias)).toBe(await realpath(kit.project))
    await unlink(alias)
    await kit.page.evaluate(
      async ({ alias, owner, draftBucket, refsBucket, raw, ownerBucket, legacyMapping }) => {
        const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
        await bridge.storageSet(draftBucket, "notes.txt", raw)
        await bridge.storageSet(refsBucket, "notes.txt", JSON.stringify([owner, "sleeping-owner"]))
        await bridge.storageSet(
          ownerBucket,
          "layout",
          JSON.stringify({
            version: 1,
            directory: alias,
            visible: true,
            selected: "legacy",
            tabs: [{ id: "legacy", kind: "file", path: "notes.txt", fileDirectory: alias }],
          }),
        )
        if (legacyMapping) await bridge.storageSet("file-directories", alias.replace(/\\/g, "/"), JSON.stringify(alias))
      },
      { alias, owner, draftBucket, refsBucket, raw, ownerBucket: `panels-${encode(owner)}`, legacyMapping },
    )
    const canonical = await realpath(kit.project)
    const stored = () =>
      kit.page.evaluate(
        async ({ alias, draftBucket, refsBucket, actualBucket }) => {
          const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
          return {
            mapping: await bridge.storageGet("file-directories", alias.replace(/\\/g, "/")),
            draft: await bridge.storageGet(draftBucket, "notes.txt"),
            oldOwners: await bridge.storageGet(refsBucket, "notes.txt"),
            owners: JSON.parse((await bridge.storageGet(actualBucket, "notes.txt")) ?? "[]") as string[],
          }
        },
        { alias, draftBucket, refsBucket, actualBucket: `file-links-${encode(canonical)}` },
      )
    const visit = () => kit.page.goto(`${new URL(kit.page.url()).origin}/${encode(alias)}/session`)
    await visit()
    await expect(kit.page.getByRole("alert")).toContainText("MRK-1009")
    const missing = await stored()
    expect(missing.mapping).toBe(legacyMapping ? JSON.stringify(alias) : null)
    expect(missing.draft).toBe(raw)
    expect(JSON.parse(missing.oldOwners!)).toEqual([owner, "sleeping-owner"])
    await symlink(kit.project, alias, process.platform === "win32" ? "junction" : "dir")
    expect(await realpath(alias)).toBe(await realpath(kit.project))
    await kit.page.getByRole("button", { name: "重试", exact: true }).click()
    if (legacyMapping) {
      await expect(kit.page.getByRole("alert")).toContainText(canonical)
      expect((await stored()).draft).toBe(raw)
      await kit.page.getByRole("button", { name: "确认归属并恢复草稿", exact: true }).click()
    }
    for (let restart = 0; restart <= 2; restart++) {
      if (restart) {
        const pid = kit.app.process().pid
        await kit.restart(true)
        expect(kit.app.process().pid).not.toBe(pid)
        await visit()
      }
      await expect(kit.panel().getByRole("code").first()).toContainText("legacy recovered edits")
      await expect.poll(async () => (await stored()).owners).toEqual(expect.arrayContaining([owner, "sleeping-owner"]))
      await expect.poll(async () => (await stored()).draft).toBe(null)
      expect((await stored()).oldOwners).toBe(null)
      expect(await readFile(path.join(kit.project, "notes.txt"), "utf8")).toBe("hello from e2e\n")
    }
  })
