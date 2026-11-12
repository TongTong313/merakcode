import { createServer } from "node:http"
import { test, expect } from "./fixture"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"

for (const reload of [false, true])
  test(`a background redirect survives application restart${reload ? " after renderer reload" : ""}`, async ({
    kit,
  }) => {
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
    try {
      await kit.send("browser owner")
      await expect.poll(() => new URL(kit.page.url()).pathname).toMatch(/\/session\/[^/]+$/)
      const owner = new URL(kit.page.url()).pathname
      await kit.openPanel("browser")
      await kit.panel().getByRole("textbox", { name: "地址" }).fill(`${base}/old`)
      await kit.panel().getByRole("textbox", { name: "地址" }).press("Enter")
      await expect(kit.panel().getByRole("tab", { name: "Old page", exact: true })).toBeVisible()
      await kit.page
        .getByRole("navigation", { name: "对话" })
        .getByRole("button", { name: "新对话", exact: true })
        .click()
      await kit.send("other browser conversation")
      await expect.poll(() => new URL(kit.page.url()).pathname).toMatch(/\/session\/[^/]+$/)
      await expect.poll(() => new URL(kit.page.url()).pathname).not.toBe(owner)
      if (reload) await kit.page.reload()
      release.resolve()
      await expect
        .poll(() =>
          kit.app.evaluate(
            ({ webContents }, url) => webContents.getAllWebContents().some((item) => item.getURL() === url),
            `${base}/new`,
          ),
        )
        .toBe(true)
      await kit.restart()
      await kit.page.locator(`a[href="${owner}"]`).click()
      await expect(kit.panel().getByRole("textbox", { name: "地址" })).toHaveValue(`${base}/new`)
      await expect(kit.panel().getByRole("tab", { name: "Final page", exact: true })).toBeVisible()
    } finally {
      release.resolve()
      server.closeAllConnections()
      server.close()
    }
  })

test("an unfinished browser response does not block another page", async ({ kit }) => {
  const entered = Promise.withResolvers<void>()
  let fast = 0
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html")
    if (request.url === "/slow") {
      response.write("<title>Loading</title>")
      entered.resolve()
      return
    }
    fast++
    response.end("<title>Loaded independently</title>")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    await kit.page.evaluate((base) => {
      void (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__.browserNavigate(
        "slow-page",
        `${base}/slow`,
      )
    }, base)
    await entered.promise
    const opening = kit.page.evaluate(
      (base) =>
        (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__.browserNavigate(
          "fast-page",
          `${base}/fast`,
        ),
      base,
    )
    await expect.poll(() => fast).toBeGreaterThan(0)
    expect(await opening).toBe(true)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test("concurrent browser navigation stays within the native page budget", async ({ kit }) => {
  const server = createServer((_request, response) => response.end("<title>Budget page</title>"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    await kit.page.evaluate(async (base) => {
      const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
      for (let i = 0; i < 6; i++) await bridge.browserNavigate(`budget-${i}`, `${base}/${i}`)
      await Promise.all([
        bridge.browserNavigate("budget-a", `${base}/a`),
        bridge.browserNavigate("budget-b", `${base}/b`),
      ])
    }, base)
    const count = await kit.app.evaluate(
      ({ webContents }, base) =>
        webContents.getAllWebContents().filter((page) => page.getURL().startsWith(base)).length,
      base,
    )
    expect(count).toBeLessThanOrEqual(6)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test("browser tabs preserve separate navigation and console contents when switched", async ({ kit }) => {
  const server = createServer((request, response) => {
    const name = request.url === "/a" ? "Page A" : "Page B"
    response.setHeader("content-type", "text/html")
    response.end(`<title>${name}</title><h1>${name}</h1><script>console.error(${JSON.stringify(name)})</script>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    await kit.openPanel("browser", true)
    await kit.panel().getByRole("textbox", { name: "地址" }).fill(`${base}/a`)
    await kit.panel().getByRole("textbox", { name: "地址" }).press("Enter")
    await expect(kit.panel().getByRole("region", { name: "控制台" })).toContainText("Page A")
    await kit.openPanel("browser", true)
    await kit.panel().getByRole("textbox", { name: "地址" }).fill(`${base}/b`)
    await kit.panel().getByRole("textbox", { name: "地址" }).press("Enter")
    await expect(kit.panel().getByRole("region", { name: "控制台" })).toContainText("Page B")
    await kit.panel().getByRole("tab", { name: "Page A", exact: true }).click()
    await expect(kit.panel().getByRole("textbox", { name: "地址" })).toHaveValue(`${base}/a`)
    await expect(kit.panel().getByRole("region", { name: "控制台" })).toContainText("Page A")
    await expect(kit.panel().getByRole("region", { name: "控制台" })).not.toContainText("Page B")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
