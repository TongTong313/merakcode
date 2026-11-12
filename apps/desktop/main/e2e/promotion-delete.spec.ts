import { readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"
import { connect } from "@merakcode/sdk"
import { test, expect } from "./fixture"

test.use({ git: true, script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) } })

test("a late first-send response after deletion leaves fresh tabs and drafts usable", async ({ kit }) => {
  await kit.send("sibling conversation")
  await expect(kit.text("Reply: sibling conversation")).toBeVisible()
  const sibling = new URL(kit.page.url()).pathname
  const navigation = kit.page.getByRole("navigation", { name: "对话" })
  await navigation.getByRole("button", { name: "新对话", exact: true }).click()
  const rpc = await kit.rpc()
  const newPath = new URL(kit.page.url()).pathname
  await kit.openPanel("git")
  await kit.panel().getByRole("textbox", { name: "提交信息" }).fill("Original draft")
  // The engine accepts the first message, but its answer reaches the page only after the conversation was deleted
  const late = rpc.holdResponse("session.send")
  try {
    await kit.send("delayed first-send response")
    await expect.poll(() => rpc.seen("session.send").length).toBe(1)
    const targetID = rpc.seen("session.send")[0]!.params.session as string
    await kit.page.locator(`a[href="${sibling}"]`).click()
    const targetPath = `${newPath}/${targetID}`
    const row = kit.page.locator(".conversation-row").filter({ has: kit.page.locator(`a[href="${targetPath}"]`) })
    await row.getByRole("button").click()
    await kit.page.getByRole("menuitem", { name: "删除", exact: true }).click()
    await kit.page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click()
    await expect(kit.page.locator(`a[href="${targetPath}"]`)).toHaveCount(0)
    await navigation.getByRole("button", { name: "新对话", exact: true }).click()
    await kit.panel().getByRole("textbox", { name: "提交信息" }).fill("Fresh unrelated draft")
    late.release()
    await expect(kit.page.locator(".toast").filter({ hasText: "MRK-4025" })).toBeVisible()
    await kit.page.keyboard.press("ControlOrMeta+J")
    await expect(kit.panel().getByRole("tab", { name: /^终端/ })).toHaveCount(1)
    await kit.openPanel("browser")
    await expect(kit.panel().getByRole("textbox", { name: "地址" })).toBeVisible()
    await kit.panel().getByRole("tab", { name: "Git 管理", exact: true }).click()
    await expect(kit.panel().getByRole("textbox", { name: "提交信息" })).toHaveValue("Fresh unrelated draft")
    await kit.page.reload()
    await expect(kit.panel().getByRole("tab")).toHaveCount(3)
    await expect(kit.panel().getByRole("textbox", { name: "提交信息" })).toHaveValue("Fresh unrelated draft")
    const previous = kit.app.process().pid
    await kit.restart()
    expect(kit.app.process().pid).not.toBe(previous)
    await kit.page
      .getByRole("navigation", { name: "对话" })
      .getByRole("button", { name: "新对话", exact: true })
      .click()
    await expect(kit.panel().getByRole("tab")).toHaveCount(3)
    await expect(kit.panel().getByRole("textbox", { name: "提交信息" })).toHaveValue("Fresh unrelated draft")
  } finally {
    late.release()
  }
})

for (const stage of ["journal", "destination", "source cleanup", "cancellation record", "resource cleanup"])
  test(`deleting a failed ${stage} promotion closes its process tree and browser across two restarts`, async ({
    kit,
  }) => {
    const pids = path.join(kit.project, "deleted-terminal-pids.txt")
    const script = path.join(kit.project, "deleted-terminal-family.mjs")
    await writeFile(
      script,
      `import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n")
if (!process.argv[2]) spawn(process.execPath, [import.meta.filename, "child"], { detached: true, stdio: "ignore" }).unref()
setInterval(() => {}, 100)
`,
    )
    const ids = async () =>
      (await readFile(pids, "utf8").catch(() => "")).trim().split(/\s+/).filter(Boolean).map(Number)
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const rpc = await kit.rpc()
    const engine = await connect(JSON.parse(await readFile(path.join(kit.root, "data", "engine.json"), "utf8")))
    const server = createServer((_request, response) => response.end("<title>Transfer browser</title>"))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
    try {
      await kit.send("unrelated conversation")
      await expect(kit.text("Reply: unrelated conversation")).toBeVisible()
      const sibling = new URL(kit.page.url()).pathname
      await kit.openPanel("git")
      await kit.panel().getByRole("textbox", { name: "提交信息" }).fill("Keep the sibling draft")
      await kit.page
        .getByRole("navigation", { name: "对话" })
        .getByRole("button", { name: "新对话", exact: true })
        .click()
      await kit.openPanel("browser")
      await kit.panel().getByRole("textbox", { name: "地址" }).fill(url)
      await kit.panel().getByRole("textbox", { name: "地址" }).press("Enter")
      await expect(kit.panel().getByRole("tab", { name: "Transfer browser", exact: true })).toBeVisible()
      await kit.page.clock.install()
      await kit.openPanel("terminal", true)
      await expect.poll(async () => (await engine.terminal.list({ directory: kit.project }))?.length).toBe(1)
      const info = (await engine.terminal.list({ directory: kit.project }))![0]!
      // The page polls a live terminal; a released one must stop being polled
      const heartbeats = () => rpc.seen("terminal.get", (params) => params.id === info.id).length
      let baseline = 0
      await kit.page.getByRole("region", { name: "终端", exact: true }).click()
      await kit.page.keyboard.type(`node "${script}"`)
      await kit.page.keyboard.press("Enter")
      await expect.poll(async () => (await ids()).length).toBe(2)
      const family = [info.pid, ...(await ids())]
      await kit.page.clock.fastForward(20_000)
      await expect.poll(heartbeats).toBeGreaterThan(0)
      await kit.app.evaluate(({ ipcMain }, stage) => {
        const channel = "merakcode:invoke"
        const original = Reflect.get(ipcMain, "_invokeHandlers").get(channel)
        if (!original) throw new Error("Bridge handler missing")
        const gate = {
          cancelled: false,
          failures: 0,
          cancellationFailures: 0,
          restore: () => {
            ipcMain.removeHandler(channel)
            ipcMain.handle(channel, original)
          },
        }
        Object.assign(globalThis, { deletionTransferGate: gate })
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async (event, method, ...args) => {
          if (stage === "resource cleanup" && method === "browserClose") {
            gate.cancellationFailures++
            return false
          }
          if (method === "storageSet") {
            const [bucket, , raw] = args
            const value = JSON.parse(raw)
            if (bucket === "panel-transfers" && value.cancelled) {
              if (stage === "cancellation record") {
                gate.cancellationFailures++
                throw new Error("Injected cancellation write failure")
              }
              gate.cancelled = true
            }
            const owner = bucket.startsWith("panels-") ? Buffer.from(bucket.slice(7), "base64url").toString() : ""
            if (
              !gate.cancelled &&
              (((stage === "journal" || stage === "resource cleanup") && bucket === "panel-transfers") ||
                ((stage === "destination" || stage === "cancellation record") &&
                  !owner.startsWith("new:") &&
                  value.tabs?.some((tab: { kind: string }) => tab.kind === "terminal")) ||
                (stage === "source cleanup" && owner.startsWith("new:") && value.tabs?.length === 0))
            ) {
              gate.failures++
              throw new Error("Injected transfer storage failure")
            }
          }
          return original(event, method, ...args)
        })
      }, stage)
      await kit.send("conversation to delete")
      await expect(kit.page).toHaveURL(/\/session\/[^/]+$/)
      const deletedPath = new URL(kit.page.url()).pathname
      const sessionID = deletedPath.split("/").at(-1)!
      await expect
        .poll(() => kit.app.evaluate(() => Reflect.get(globalThis, "deletionTransferGate").failures))
        .toBeGreaterThan(0)
      await kit.page.locator(`a[href="${sibling}"]`).click()
      const row = kit.page.locator(".conversation-row").filter({ has: kit.page.locator(`a[href="${deletedPath}"]`) })
      await row.getByRole("button").click()
      await kit.page.getByRole("menuitem", { name: "删除", exact: true }).click()
      await kit.page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click()
      await expect(kit.page.locator(`a[href="${deletedPath}"]`)).toHaveCount(0)
      if (stage === "cancellation record" || stage === "resource cleanup") {
        await expect
          .poll(() => kit.app.evaluate(() => Reflect.get(globalThis, "deletionTransferGate").cancellationFailures))
          .toBeGreaterThan(0)
        const oldPID = kit.app.process().pid
        await kit.restart(true)
        expect(kit.app.process().pid).not.toBe(oldPID)
        await kit.page.clock.install()
      }
      await expect.poll(() => family.filter(alive)).toEqual([])
      await expect
        .poll(async () => (await engine.terminal.list({ directory: kit.project }))?.some((item) => item.id === info.id))
        .toBe(false)
      await expect
        .poll(() =>
          kit.app.evaluate(
            ({ webContents }, url) => webContents.getAllWebContents().some((item) => item.getURL() === url),
            url,
          ),
        )
        .toBe(false)
      const buckets = [sessionID, `new:${kit.project}`].map(
        (owner) => `panels-${Buffer.from(owner).toString("base64url")}`,
      )
      const saved = () =>
        kit.page.evaluate(async (buckets) => {
          const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
          return {
            tabs: await Promise.all(
              buckets.map(
                async (bucket) => JSON.parse((await bridge.storageGet(bucket, "layout")) ?? '{"tabs":[]}').tabs,
              ),
            ),
            transfers: await bridge.storageEntries("panel-transfers"),
            browsers: await bridge.storageEntries("browser-owners"),
          }
        }, buckets)
      await expect.poll(saved).toEqual({ tabs: [[], []], transfers: [], browsers: [] })
      await kit.app.evaluate(() => Reflect.get(globalThis, "deletionTransferGate")?.restore())
      baseline = heartbeats()
      await kit.page.clock.fastForward(60_000)
      expect(heartbeats()).toBe(baseline)
      await kit.page.reload()
      await expect.poll(saved).toEqual({ tabs: [[], []], transfers: [], browsers: [] })
      for (let restart = 0; restart < 2; restart++) {
        const previous = kit.app.process().pid
        await kit.restart()
        expect(kit.app.process().pid).not.toBe(previous)
        await kit.page.locator(`a[href="${sibling}"]`).click()
        await expect(kit.panel().getByRole("textbox", { name: "提交信息" })).toHaveValue("Keep the sibling draft")
        await expect.poll(saved).toEqual({ tabs: [[], []], transfers: [], browsers: [] })
      }
    } finally {
      await kit.app.evaluate(() => Reflect.get(globalThis, "deletionTransferGate")?.restore()).catch(() => {})
      for (const pid of await ids())
        if (alive(pid)) {
          try {
            process.kill(pid, "SIGKILL")
          } catch {}
        }
      await engine.close().catch(() => {})
      server.closeAllConnections()
      server.close()
    }
  })
