import { createServer } from "node:http"
import { test, expect } from "./fixture"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"

test.use({ git: true, script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) } })

for (const restart of [false, true])
  test(`a failed source cleanup recovers its original owner after ${restart ? "process restart" : "reload"}`, async ({
    kit,
  }) => {
    await kit.openPanel("git")
    await kit.panel().getByRole("textbox", { name: "提交信息" }).fill("Keep the original commit draft")
    await kit.openPanel("plan")
    await kit.openPanel("browser")
    await kit.openPanel("terminal")
    await expect(kit.page.locator(".terminal-host textarea")).toBeAttached()
    await kit.app.evaluate(
      (_, prefix) => {
        const fs = process.getBuiltinModule("fs")
        const { syncBuiltinESMExports } = process.getBuiltinModule("module")
        const original = fs.writeFileSync
        fs.writeFileSync = (...args: Parameters<typeof original>) => {
          if (String(args[0]).includes(prefix)) {
            const layout = JSON.parse(String(args[1])).layout
            if (layout && JSON.parse(layout).tabs.length === 0) throw new Error("Source cleanup unavailable")
          }
          return original(...args)
        }
        syncBuiltinESMExports()
        Object.assign(globalThis, {
          restorePromotionWrites: () => {
            fs.writeFileSync = original
            syncBuiltinESMExports()
          },
        })
      },
      `panels-${Buffer.from(`new:${kit.project}`).toString("base64url")}`,
    )
    try {
      await kit.send("original owner")
      await expect(kit.page.getByText(/MRK-4025/).first()).toBeVisible()
      await expect(kit.page).toHaveURL(/\/session\/[^/]+$/)
      const owner = new URL(kit.page.url()).pathname
      if (restart) {
        const previousPID = kit.app.process().pid
        await kit.restart(true)
        expect(kit.app.process().pid).not.toBe(previousPID)
        await kit.page.locator(`a[href="${owner}"]`).click()
      } else {
        await kit.app.evaluate(() => Reflect.get(globalThis, "restorePromotionWrites")())
        await kit.page.reload()
      }
      await expect(kit.panel().getByRole("tab")).toHaveCount(4)
      await kit.page
        .getByRole("navigation", { name: "对话" })
        .getByRole("button", { name: "新对话", exact: true })
        .click()
      await kit.send("second owner")
      await expect(kit.text("Reply: second owner")).toBeVisible()
      await expect(kit.panel().getByRole("tab")).toHaveCount(0)
      await kit.page.locator(`a[href="${owner}"]`).click()
      await expect(kit.panel().getByRole("tab")).toHaveCount(4)
      await kit.panel().getByRole("tab", { name: "Git 管理", exact: true }).click()
      await expect(kit.panel().getByRole("textbox", { name: "提交信息" })).toHaveValue("Keep the original commit draft")
    } finally {
      await kit.app
        .evaluate(() => {
          const restore = Reflect.get(globalThis, "restorePromotionWrites")
          if (typeof restore === "function") restore()
        })
        .catch(() => {})
    }
  })

test("a browser redirect after a failed promotion survives process restart", async ({ kit }) => {
  const release = Promise.withResolvers<void>()
  let oldLoads = 0
  const server = createServer((request, response) => {
    if (request.url === "/wait") {
      void release.promise.then(() => response.end("ready"))
      return
    }
    response.setHeader("content-type", "text/html")
    response.end(
      request.url === "/old"
        ? `<title>Old page</title>${oldLoads++ === 0 ? '<script>fetch("/wait").then(() => location.replace("/new"))</script>' : ""}`
        : "<title>Final page</title>Final address",
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const sourceBucket = `panels-${Buffer.from(`new:${kit.project}`).toString("base64url")}`
  try {
    await kit.openPanel("browser")
    await kit.panel().getByRole("textbox", { name: "地址" }).fill(`${base}/old`)
    await kit.panel().getByRole("textbox", { name: "地址" }).press("Enter")
    await expect(kit.panel().getByRole("tab", { name: "Old page", exact: true })).toBeVisible()
    await kit.app.evaluate((_, sourceBucket) => {
      const fs = process.getBuiltinModule("fs")
      const { syncBuiltinESMExports } = process.getBuiltinModule("module")
      const original = fs.writeFileSync
      fs.writeFileSync = (...args: Parameters<typeof original>) => {
        if (String(args[0]).includes("panels-") && !String(args[0]).includes(sourceBucket))
          throw new Error("Destination unavailable")
        return original(...args)
      }
      syncBuiltinESMExports()
      Object.assign(globalThis, {
        restorePromotionWrites: () => {
          fs.writeFileSync = original
          syncBuiltinESMExports()
        },
      })
    }, sourceBucket)
    await kit.send("browser original owner")
    await expect(kit.page.getByText(/MRK-4025/).first()).toBeVisible()
    await expect(kit.page).toHaveURL(/\/session\/[^/]+$/)
    const owner = new URL(kit.page.url()).pathname
    release.resolve()
    await expect
      .poll(() =>
        kit.page.evaluate(async (bucket) => {
          const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
          const layout = JSON.parse((await bridge.storageGet(bucket, "layout"))!)
          return layout.tabs[0]
        }, sourceBucket),
      )
      .toMatchObject({ url: `${base}/new`, title: "Final page" })
    const previousPID = kit.app.process().pid
    await kit.restart(true)
    expect(kit.app.process().pid).not.toBe(previousPID)
    await kit.page.locator(`a[href="${owner}"]`).click()
    await expect(kit.panel().getByRole("textbox", { name: "地址" })).toHaveValue(`${base}/new`)
    await expect(kit.panel().getByRole("tab", { name: "Final page", exact: true })).toBeVisible()
  } finally {
    release.resolve()
    await kit.app
      .evaluate(() => {
        const restore = Reflect.get(globalThis, "restorePromotionWrites")
        if (typeof restore === "function") restore()
      })
      .catch(() => {})
    server.closeAllConnections()
    server.close()
  }
})
