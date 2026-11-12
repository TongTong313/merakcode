import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"
import { test, expect } from "./fixture"

test.use({ git: true, script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) } })

for (const stage of ["destination", "source cleanup"])
  test(`an offline ${stage} transfer preserves drafts and background navigation across two restarts`, async ({
    kit,
  }) => {
    const directory = path.join(kit.root, "offline-transfer")
    const moved = `${directory}-removed`
    const encode = (value: string) => Buffer.from(value).toString("base64url")
    const origin = () => new URL(kit.page.url()).origin
    const redirect = Promise.withResolvers<void>()
    const server = createServer((request, response) => {
      if (request.url === "/wait") return void redirect.promise.then(() => response.end("ready"))
      const name = request.url!.slice(1)
      response.setHeader("content-type", "text/html")
      response.end(
        `<title>${name}</title>${name.endsWith("old") ? '<script>fetch("/wait").then(() => location.replace(location.pathname.replace("old", "final")))</script>' : ""}`,
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const stored = (bucket: string, key = "layout") =>
      kit.page.evaluate(
        async ({ bucket, key }) => {
          const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
          return bridge.storageGet(bucket, key)
        },
        { bucket, key },
      )
    const drafts = () =>
      kit.page.evaluate(async () => {
        const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
        return JSON.stringify(
          await Promise.all(
            (await bridge.storageBuckets())
              .filter((bucket) => bucket.startsWith("draft-"))
              .map((bucket) => bridge.storageEntries(bucket)),
          ),
        )
      })
    try {
      await mkdir(directory)
      await writeFile(path.join(directory, "notes.txt"), "offline baseline\n")
      await kit.send("healthy transfer sibling")
      await expect(kit.text("Reply: healthy transfer sibling")).toBeVisible()
      const healthy = new URL(kit.page.url()).pathname
      const healthyBucket = `panels-${encode(healthy.split("/").at(-1)!)}`
      await kit.openPanel("browser")
      await kit.panel().getByRole("textbox", { name: "地址" }).fill(`${base}/healthy-old`)
      await kit.panel().getByRole("textbox", { name: "地址" }).press("Enter")
      await expect(kit.panel().getByRole("tab", { name: "healthy-old", exact: true })).toBeVisible()
      await kit.openPanel("git")
      await kit.panel().getByRole("textbox", { name: "提交信息" }).fill("Keep healthy draft")
      await kit.page.goto(`${origin()}/${encode(directory)}/session`)
      await kit.openPanel("file")
      await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
      const editor = () => kit.panel().getByRole("code").first()
      await expect(editor()).toContainText("offline baseline")
      await editor().click()
      await kit.page.keyboard.press("ControlOrMeta+A")
      await kit.page.keyboard.type("Keep offline unsaved text")
      await expect.poll(drafts).toContain("Keep offline unsaved text")
      await kit.openPanel("browser")
      await kit.panel().getByRole("textbox", { name: "地址" }).fill(`${base}/offline-old`)
      await kit.panel().getByRole("textbox", { name: "地址" }).press("Enter")
      await expect(kit.panel().getByRole("tab", { name: "offline-old", exact: true })).toBeVisible()
      await kit.app.evaluate(
        ({ ipcMain }, { stage, directory }) => {
          const channel = "merakcode:invoke"
          const original = Reflect.get(ipcMain, "_invokeHandlers").get(channel)
          const gate = {
            failures: 0,
            restore: () => {
              ipcMain.removeHandler(channel)
              ipcMain.handle(channel, original)
            },
          }
          Object.assign(globalThis, { offlineTransferGate: gate })
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, async (event, method, ...args) => {
            if (method === "storageSet" && args[0].startsWith("panels-")) {
              const owner = Buffer.from(args[0].slice(7), "base64url").toString()
              const layout = JSON.parse(args[2])
              if (
                (stage === "destination" && !owner.startsWith("new:") && layout.directory === directory) ||
                (stage === "source cleanup" && owner === `new:${directory}` && layout.tabs?.length === 0)
              ) {
                gate.failures++
                throw new Error("Injected transfer write failure")
              }
            }
            return original(event, method, ...args)
          })
        },
        { stage, directory },
      )
      await kit.send("offline transfer owner")
      await expect(kit.page).toHaveURL(/\/session\/[^/]+$/)
      const owner = new URL(kit.page.url()).pathname
      const sessionID = owner.split("/").at(-1)!
      await expect
        .poll(() => kit.app.evaluate(() => Reflect.get(globalThis, "offlineTransferGate").failures))
        .toBeGreaterThan(0)
      const journal = await stored("panel-transfers", sessionID)
      expect(journal).not.toBeNull()
      await rename(directory, moved)
      await kit.app.evaluate(() => Reflect.get(globalThis, "offlineTransferGate").restore())
      await kit.page.goto(`${origin()}${healthy}`)
      await kit.page.reload()
      await expect(kit.panel().getByRole("textbox", { name: "提交信息" })).toHaveValue("Keep healthy draft")
      expect(await stored("panel-transfers", sessionID)).toBe(journal)
      redirect.resolve()
      await expect
        .poll(async () => JSON.parse((await stored(healthyBucket))!).tabs)
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "browser", url: `${base}/healthy-final`, title: "healthy-final" }),
          ]),
        )
      await expect
        .poll(async () => JSON.parse((await stored("panel-transfers", sessionID))!).snapshot.tabs)
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "browser", url: `${base}/offline-final`, title: "offline-final" }),
          ]),
        )
      for (let restart = 0; restart < 2; restart++) {
        const pid = kit.app.process().pid
        await kit.restart()
        expect(kit.app.process().pid).not.toBe(pid)
        await kit.page.goto(`${origin()}${healthy}`)
        await expect(kit.panel().getByRole("textbox", { name: "提交信息" })).toHaveValue("Keep healthy draft")
        await kit.panel().getByRole("tab", { name: "healthy-final", exact: true }).click()
        await expect(kit.panel().getByRole("textbox", { name: "地址" })).toHaveValue(`${base}/healthy-final`)
        await kit.panel().getByRole("tab", { name: "Git 管理", exact: true }).click()
        expect(await stored("panel-transfers", sessionID)).not.toBeNull()
        expect(await drafts()).toContain("Keep offline unsaved text")
      }
      await rename(moved, directory)
      await kit.page.goto(`${origin()}${owner}`)
      await expect(kit.panel().getByRole("tab")).toHaveCount(2)
      await kit.panel().getByRole("tab", { name: "offline-final", exact: true }).click()
      await expect(kit.panel().getByRole("textbox", { name: "地址" })).toHaveValue(`${base}/offline-final`)
      await kit
        .panel()
        .getByRole("tab", { name: /^notes\.txt/ })
        .click()
      await expect(editor()).toContainText("Keep offline unsaved text")
      expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe("offline baseline\n")
      expect(await stored("panel-transfers", sessionID)).toBeNull()
      await kit.page.reload()
      await expect(kit.panel().getByRole("tab")).toHaveCount(2)
      await expect(editor()).toContainText("Keep offline unsaved text")
      await kit.page.goto(`${origin()}/${encode(directory)}/session`)
      await expect(kit.panel().getByRole("tab")).toHaveCount(0)
    } finally {
      redirect.resolve()
      await kit.app.evaluate(() => Reflect.get(globalThis, "offlineTransferGate")?.restore()).catch(() => {})
      await rename(moved, directory).catch(() => {})
      server.closeAllConnections()
      server.close()
    }
  })
