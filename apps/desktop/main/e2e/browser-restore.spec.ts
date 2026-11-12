import { createServer } from "node:http"
import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"
import { test, expect } from "./fixture"

test.use({ git: true, script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) } })

test("a background browser persists after controller eviction while its file directory is offline", async ({ kit }) => {
  const redirect = Promise.withResolvers<void>()
  let oldLoads = 0
  const server = createServer((request, response) => {
    if (request.url === "/wait") return void redirect.promise.then(() => response.end("ready"))
    response.setHeader("content-type", "text/html")
    response.end(
      request.url === "/old"
        ? `<title>Old page</title>${oldLoads++ === 0 ? '<script>fetch("/wait").then(() => location.replace("/new"))</script>' : ""}`
        : "<title>Final page</title>Final destination",
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const directory = path.join(kit.root, "offline-browser-files")
  const moved = `${directory}-offline`
  await mkdir(directory)
  await writeFile(path.join(directory, "notes.txt"), "keep this file")
  try {
    await kit.send("offline browser owner")
    await expect(kit.text("Reply: offline browser owner")).toBeVisible()
    const owner = new URL(kit.page.url()).pathname
    const sessionID = owner.split("/").at(-1)!
    const bucket = `panels-${Buffer.from(sessionID).toString("base64url")}`
    await kit.page.evaluate(
      async ({ bucket, directory }) => {
        const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
        await bridge.storageSet(
          bucket,
          "layout",
          JSON.stringify({
            version: 1,
            tabs: [{ id: "offline-file", kind: "file", path: "notes.txt", fileDirectory: directory }],
          }),
        )
      },
      { bucket, directory },
    )
    await kit.page.reload()
    await kit.page.getByRole("button", { name: "右侧面板", exact: true }).click()
    await expect(kit.panel().getByRole("tab", { name: /^notes\.txt/ })).toHaveCount(1)
    await kit.openPanel("browser")
    await kit.panel().getByRole("textbox", { name: "地址" }).fill(`${base}/old`)
    await kit.panel().getByRole("textbox", { name: "地址" }).press("Enter")
    await expect(kit.panel().getByRole("tab", { name: "Old page", exact: true })).toBeVisible()
    for (let index = 0; index < 33; index++) {
      await kit.page
        .getByRole("navigation", { name: "对话" })
        .getByRole("button", { name: "新对话", exact: true })
        .click()
      await kit.send(`empty browser visit ${index}`)
      await expect(kit.text(`Reply: empty browser visit ${index}`)).toBeVisible()
    }
    await rename(directory, moved)
    redirect.resolve()
    await expect
      .poll(() =>
        kit.app.evaluate(
          ({ webContents }, url) => webContents.getAllWebContents().some((page) => page.getURL() === url),
          `${base}/new`,
        ),
      )
      .toBe(true)
    const saved = () =>
      kit.page.evaluate(async (bucket) => {
        const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
        return JSON.parse((await bridge.storageGet(bucket, "layout"))!).tabs
      }, bucket)
    await expect
      .poll(saved)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "offline-file", path: "notes.txt" }),
          expect.objectContaining({ kind: "browser", url: `${base}/new`, title: "Final page" }),
        ]),
      )
    const previousPID = kit.app.process().pid
    await kit.restart()
    expect(kit.app.process().pid).not.toBe(previousPID)
    await rename(moved, directory)
    await kit.page.locator(`a[href="${owner}"]`).click()
    await kit.panel().getByRole("tab", { name: "Final page", exact: true }).click()
    await expect(kit.panel().getByRole("textbox", { name: "地址" })).toHaveValue(`${base}/new`)
    expect(oldLoads).toBe(1)
  } finally {
    redirect.resolve()
    await rename(moved, directory).catch(() => {})
    server.closeAllConnections()
    server.close()
  }
})

for (const [blocked, evicted] of [
  [false, false],
  [true, false],
  [true, true],
])
  test(`activating a redirected browser preserves its address (pending file: ${blocked}, evicted: ${evicted})`, async ({
    kit,
  }) => {
    const redirect = Promise.withResolvers<void>()
    const rpc = await kit.rpc()
    let pending: { release: () => void } | undefined
    let oldLoads = 0
    const server = createServer((request, response) => {
      if (request.url === "/wait") {
        void redirect.promise.then(() => response.end("ready"))
        return
      }
      response.setHeader("content-type", "text/html")
      response.end(
        request.url === "/old"
          ? `<title>Old page</title>${oldLoads++ === 0 ? '<script>fetch("/wait").then(() => location.replace("/new"))</script>' : ""}`
          : "<title>Final page</title>Final destination",
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const nativeURL = () =>
      kit.app.evaluate(
        ({ webContents }, base) =>
          webContents
            .getAllWebContents()
            .map((item) => item.getURL())
            .find((url) => url === `${base}/old` || url === `${base}/new`),
        base,
      )
    try {
      await kit.send("browser activation owner")
      await expect(kit.page).toHaveURL(/\/session\/[^/]+$/)
      await expect(kit.text("Reply: browser activation owner")).toBeVisible()
      const owner = new URL(kit.page.url()).pathname
      const sessionID = owner.split("/").at(-1)!
      const bucket = `panels-${Buffer.from(sessionID).toString("base64url")}`
      const saved = () =>
        kit.page.evaluate(async (bucket) => {
          const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
          const raw = await bridge.storageGet(bucket, "layout")
          return raw && JSON.parse(raw).tabs.find((tab: { kind: string }) => tab.kind === "browser")
        }, bucket)
      await kit.openPanel("browser")
      await kit.panel().getByRole("textbox", { name: "地址" }).fill(`${base}/old`)
      await kit.panel().getByRole("textbox", { name: "地址" }).press("Enter")
      await expect(kit.panel().getByRole("tab", { name: "Old page", exact: true })).toBeVisible()
      if (evicted) for (let index = 0; index < 6; index++) await kit.openPanel("browser", true)
      await kit.openPanel("git")
      await expect(kit.panel().getByRole("textbox", { name: "提交信息" })).toBeVisible()
      if (blocked) {
        const identityHold = rpc.hold("file.identity", { match: (params) => params.path === "notes.txt" })
        pending = identityHold
        await kit.openPanel("file")
        await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
        await identityHold.entered
      }
      redirect.resolve()
      await expect.poll(nativeURL).toBe(`${base}/new`)
      if (evicted) {
        await kit.page.evaluate(async (base) => {
          const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
          for (let index = 0; index < 6; index++)
            await bridge.browserNavigate(`cache-${index}`, `${base}/cache-${index}`)
        }, base)
        await expect.poll(nativeURL).toBeUndefined()
      }
      await expect(kit.panel().getByRole("tab", { name: "Final page", exact: true })).toBeVisible()
      await kit.panel().getByRole("tab", { name: "Final page", exact: true }).click()
      await expect(kit.panel().getByRole("textbox", { name: "地址" })).toHaveValue(`${base}/new`)
      pending?.release()
      if (blocked) await expect(kit.panel().getByRole("tab", { name: /^notes\.txt/ })).toHaveCount(1)
      await expect.poll(saved).toMatchObject({ url: `${base}/new`, title: "Final page" })
      const oldPID = kit.app.process().pid
      await kit.restart()
      expect(kit.app.process().pid).not.toBe(oldPID)
      await kit.page.locator(`a[href="${owner}"]`).click()
      await kit.panel().getByRole("tab", { name: "Final page", exact: true }).click()
      await expect(kit.panel().getByRole("textbox", { name: "地址" })).toHaveValue(`${base}/new`)
      await expect.poll(nativeURL).toBe(`${base}/new`)
      expect(oldLoads).toBe(1)
    } finally {
      pending?.release()
      redirect.resolve()
      server.closeAllConnections()
      server.close()
    }
  })

test("closing a queued browser restore leaves no native page behind", async ({ kit }) => {
  const server = createServer((_request, response) => response.end("<title>Restored page</title>"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const closed = await kit.page.evaluate(async (base) => {
      const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
      for (let index = 0; index < 6; index++) await bridge.browserNavigate(`budget-${index}`, `${base}/${index}`)
      const evicting = bridge.browserRestore("first-restore", `${base}/first`)
      const restoring = bridge.browserRestore("closed-restore", `${base}/closed`)
      const closing = bridge.browserClose("closed-restore")
      await Promise.all([evicting, restoring])
      return closing
    }, base)
    expect(closed).toBe(true)
    const urls = await kit.app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((page) => page.getURL()),
    )
    expect(urls).toContain(`${base}/first`)
    expect(urls).not.toContain(`${base}/closed`)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test("closing a browser cancels its delayed response and preserves the closed layout after restart", async ({
  kit,
}) => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const disconnected = Promise.withResolvers<void>()
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html")
    if (request.url !== "/slow") return void response.end("<title>Ready page</title>")
    response.once("close", () => disconnected.resolve())
    entered.resolve()
    void finish.promise.then(() => response.end("<title>Late page</title>"))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    await kit.send("closed browser owner")
    await expect(kit.text("Reply: closed browser owner")).toBeVisible()
    const owner = new URL(kit.page.url()).pathname
    await kit.openPanel("browser")
    const address = kit.panel().getByRole("textbox", { name: "地址" })
    await address.fill(`${base}/ready`)
    await address.press("Enter")
    await expect(kit.panel().getByRole("tab", { name: "Ready page", exact: true })).toBeVisible()
    await address.fill(`${base}/slow`)
    await address.press("Enter")
    await entered.promise
    await kit.panel().getByRole("button", { name: "关闭 Ready page", exact: true }).click()
    await expect(kit.panel().getByRole("tab")).toHaveCount(0)
    await disconnected.promise
    expect(await kit.page.getByRole("status").filter({ hasText: "MRK-5020" }).count()).toBe(0)
    finish.resolve()
    const oldPID = kit.app.process().pid
    await kit.restart()
    expect(kit.app.process().pid).not.toBe(oldPID)
    await kit.page.locator(`a[href="${owner}"]`).click()
    await expect(kit.panel().getByRole("tab")).toHaveCount(0)
    const state = await kit.page.evaluate(async (owner) => {
      const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
      const sessionID = owner.split("/").at(-1)!
      const bucket = `panels-${btoa(sessionID).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`
      return {
        layout: await bridge.storageGet(bucket, "layout"),
        owners: await bridge.storageEntries("browser-owners"),
      }
    }, owner)
    expect(JSON.parse(state.layout!).tabs).toEqual([])
    expect(state.owners).toEqual([])
    const urls = await kit.app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((page) => page.getURL()),
    )
    expect(urls.some((url) => url.startsWith(base))).toBe(false)
  } finally {
    finish.resolve()
    server.closeAllConnections()
    server.close()
  }
})

test("a restore requested while a browser closes cannot reopen the closed tab", async ({ kit }) => {
  const server = createServer((_request, response) => response.end("<title>Closing page</title>"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const result = await kit.page.evaluate(async (base) => {
      const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
      await bridge.browserNavigate("closing-tab", `${base}/closing`)
      const closing = bridge.browserClose("closing-tab")
      const restoring = bridge.browserRestore("closing-tab", `${base}/closing`)
      return Promise.all([closing, restoring])
    }, base)
    expect(result).toEqual([true, false])
    const urls = await kit.app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((page) => page.getURL()),
    )
    expect(urls).not.toContain(`${base}/closing`)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test("releasing browser resources keeps the tab restorable and persists later navigation", async ({ kit }) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html")
    response.end(`<title>${request.url === "/after" ? "After release" : "Before release"}</title>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const nativeURL = () =>
    kit.app.evaluate(
      ({ webContents }, base) =>
        webContents
          .getAllWebContents()
          .map((page) => page.getURL())
          .find((url) => url.startsWith(base)),
      base,
    )
  try {
    await kit.send("released browser owner")
    await expect(kit.text("Reply: released browser owner")).toBeVisible()
    const owner = new URL(kit.page.url()).pathname
    await kit.openPanel("browser")
    await kit.panel().getByRole("textbox", { name: "地址" }).fill(`${base}/before`)
    await kit.panel().getByRole("textbox", { name: "地址" }).press("Enter")
    await expect(kit.panel().getByRole("tab", { name: "Before release", exact: true })).toBeVisible()
    await kit.page.keyboard.press("ControlOrMeta+K")
    const palette = kit.page.getByRole("dialog", { name: "命令面板" })
    await palette.getByRole("combobox").fill("关闭当前会话的编辑区资源")
    await kit.page.keyboard.press("Enter")
    await expect(palette).toHaveCount(0)
    await expect(kit.panel()).not.toBeVisible()
    await expect.poll(nativeURL).toBeUndefined()
    await kit.page.getByRole("button", { name: "右侧面板", exact: true }).click()
    await expect(kit.panel().getByRole("tab", { name: "Before release", exact: true })).toBeVisible()
    await expect.poll(nativeURL).toBe(`${base}/before`)
    await kit.panel().getByRole("textbox", { name: "地址" }).fill(`${base}/after`)
    await kit.panel().getByRole("textbox", { name: "地址" }).press("Enter")
    await expect(kit.panel().getByRole("tab", { name: "After release", exact: true })).toBeVisible()
    await expect.poll(nativeURL).toBe(`${base}/after`)
    await kit.restart()
    await kit.page.locator(`a[href="${owner}"]`).click()
    await expect(kit.panel().getByRole("tab", { name: "After release", exact: true })).toBeVisible()
    await expect.poll(nativeURL).toBe(`${base}/after`)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test("an admitted navigation remains accepted when closing cancels its response", async ({ kit }) => {
  const entered = Promise.withResolvers<void>()
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html")
    response.write("<title>Pending page</title>")
    entered.resolve()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const navigating = kit.page.evaluate((base) => {
      const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
      return bridge.browserNavigate("cancelled-navigation", base)
    }, base)
    await entered.promise
    const closed = await kit.page.evaluate(() => {
      const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
      return bridge.browserClose("cancelled-navigation")
    })
    expect(closed).toBe(true)
    expect(await navigating).toBe(true)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test("explicit navigation, history and reload still change an existing browser page", async ({ kit }) => {
  let secondLoads = 0
  const server = createServer((request, response) => {
    const second = request.url === "/second"
    if (second) secondLoads++
    response.setHeader("content-type", "text/html")
    response.end(`<title>${second ? "Second page" : "First page"}</title>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    await kit.openPanel("browser")
    const address = kit.panel().getByRole("textbox", { name: "地址" })
    await address.fill(`${base}/first`)
    await address.press("Enter")
    await expect(kit.panel().getByRole("tab", { name: "First page", exact: true })).toBeVisible()
    await address.fill(`${base}/second`)
    await address.press("Enter")
    await expect(kit.panel().getByRole("tab", { name: "Second page", exact: true })).toBeVisible()
    await kit.panel().getByRole("button", { name: "后退", exact: true }).click()
    await expect(address).toHaveValue(`${base}/first`)
    await kit.panel().getByRole("button", { name: "前进", exact: true }).click()
    await expect(address).toHaveValue(`${base}/second`)
    const beforeReload = secondLoads
    await kit.panel().getByRole("button", { name: "刷新", exact: true }).click()
    await expect.poll(() => secondLoads).toBeGreaterThan(beforeReload)
    await expect(kit.panel().getByRole("tab", { name: "Second page", exact: true })).toBeVisible()
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
