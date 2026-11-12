import { writeFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"

test.use({ git: true, script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) } })

test("a healthy chat should restore its panel while another migration response is pending", async ({ kit }) => {
  const rpc = await kit.rpc()
  const filename = "migration-recovery-notes.txt"
  await writeFile(path.join(kit.project, filename), "recovery fixture\n")
  await kit.send("healthy recovery chat")
  await expect(kit.text("Reply: healthy recovery chat")).toBeVisible()
  const healthy = new URL(kit.page.url()).pathname
  const healthyID = healthy.split("/").at(-1)!
  await kit.openPanel("git")
  await kit.panel().getByRole("textbox", { name: "提交信息" }).fill("Keep healthy recovery draft")
  await kit.page.getByRole("navigation", { name: "对话" }).getByRole("button", { name: "新对话", exact: true }).click()
  await kit.openPanel("file")
  await kit.panel().getByRole("treeitem", { name: filename, exact: true }).click()
  await expect(kit.panel().getByRole("code").first()).toContainText("recovery fixture")

  await kit.app.evaluate(({ ipcMain }, ownerID) => {
    const channel = "merakcode:invoke"
    const original = Reflect.get(ipcMain, "_invokeHandlers").get(channel)
    const state = {
      hits: 0,
      restore() {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, original)
      },
    }
    Object.assign(globalThis, { migrationRecovery: state })
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, method, ...args) => {
      if (method === "storageSet" && args[0].startsWith("panels-")) {
        const owner = Buffer.from(args[0].slice(7), "base64url").toString()
        if (!owner.startsWith("new:") && owner !== ownerID && JSON.parse(args[2]).tabs?.length) {
          state.hits++
          throw new Error("Injected destination write failure")
        }
      }
      return original(event, method, ...args)
    })
  }, healthyID)
  try {
    await kit.send("interrupted migration recovery chat")
    await expect(kit.page).toHaveURL(/\/session\/[^/]+$/)
    await expect
      .poll(() => kit.app.evaluate(() => Reflect.get(globalThis, "migrationRecovery").hits))
      .toBeGreaterThan(0)
  } finally {
    await kit.app.evaluate(() => Reflect.get(globalThis, "migrationRecovery").restore())
  }
  const owner = new URL(kit.page.url()).pathname
  const targetID = owner.split("/").at(-1)!
  const journal = await kit.page.evaluate(
    (id) => (Reflect.get(window, "__MERAKCODE_DESKTOP__") as DesktopBridge).storageGet("panel-transfers", id),
    targetID,
  )
  expect(journal).not.toBeNull()
  await kit.page.goto(new URL(healthy, kit.page.url()).href)
  const commit = kit.panel().getByRole("textbox", { name: "提交信息" })
  await expect(commit).toHaveValue("Keep healthy recovery draft")
  const identity = rpc.hold("file.identity", { match: (params) => params.path === filename })
  try {
    await kit.page.locator(`a[href="${owner}"]`).click()
    await expect.poll(() => identity.calls.length, { timeout: 5000 }).toBeGreaterThan(0)
    await kit.page.locator(`a[href="${healthy}"]`).click()
    await expect(kit.page).toHaveURL(new URL(healthy, kit.page.url()).href)
    await expect(commit).toHaveValue("Keep healthy recovery draft", { timeout: 1500 })
  } finally {
    identity.release()
    await expect(commit).toHaveValue("Keep healthy recovery draft", { timeout: 10000 })
  }
})
