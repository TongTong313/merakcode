import { createServer } from "node:http"
import { test, expect } from "./fixture"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"

test("an uppercase HTTP scheme works in the browser address bar", async ({ kit }) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html")
    response.end(request.url === "/lower" ? "<title>Lowercase control</title>" : "<title>Uppercase address</title>")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const errors: string[] = []
  kit.page.on("pageerror", (error) => errors.push(error.message))
  try {
    await kit.openPanel("browser")
    const address = kit.panel().getByRole("textbox", { name: "地址" })
    await address.fill(`http://127.0.0.1:${port}/lower`)
    await address.press("Enter")
    await expect(kit.panel().getByRole("tab", { name: "Lowercase control", exact: true })).toBeVisible()
    await address.fill(`HTTP://127.0.0.1:${port}/upper`)
    await address.press("Enter")
    await expect(kit.panel().getByRole("tab", { name: "Uppercase address", exact: true })).toBeVisible({
      timeout: 2000,
    })
    expect(errors).toEqual([])
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test("an unsupported browser address reports a recovery error without an unhandled rejection", async ({ kit }) => {
  const errors: string[] = []
  kit.page.on("pageerror", (error) => errors.push(error.message))
  await kit.openPanel("browser")
  const address = kit.panel().getByRole("textbox", { name: "地址" })
  await address.fill("ftp://127.0.0.1/unsupported")
  await address.press("Enter")
  await expect(kit.page.getByText(/MRK-7016/)).toBeVisible()
  expect(errors).toEqual([])
})

test("restoring an invalid browser address reports a recovery error and retains the tab", async ({ kit }) => {
  await kit.send("restore invalid browser address")
  await expect(kit.page).toHaveURL(/\/session\/ses_/)
  const sessionID = new URL(kit.page.url()).pathname.split("/").at(-1)!
  await kit.page.evaluate(
    async (bucket) => {
      const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
      await bridge.storageSet(
        bucket,
        "layout",
        JSON.stringify({
          version: 1,
          visible: true,
          selected: "invalid-browser",
          tabs: [{ id: "invalid-browser", kind: "browser", url: "ftp://127.0.0.1/old", title: "Retained browser" }],
        }),
      )
    },
    `panels-${Buffer.from(sessionID).toString("base64url")}`,
  )
  const errors: string[] = []
  kit.page.on("pageerror", (error) => errors.push(error.message))
  await kit.page.reload()
  await expect(kit.page.getByText(/MRK-7016/)).toBeVisible()
  await expect(kit.panel().getByRole("tab", { name: "Retained browser", exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
