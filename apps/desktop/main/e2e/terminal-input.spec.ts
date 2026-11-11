import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"
import type { WebSocketRoute } from "@playwright/test"

test("a closed terminal output connection offers retry and reconnects the same running process", async ({ kit }) => {
  const connections: { page: WebSocketRoute; server: WebSocketRoute }[] = []
  const output: string[] = []
  await kit.page.routeWebSocket(
    (url) => url.pathname.endsWith("/connect") && url.searchParams.get("cursor") === "0",
    (socket) => {
      const server = socket.connectToServer()
      connections.push({ page: socket, server })
      server.onMessage((data) => {
        if (typeof data === "string") output.push(data)
        socket.send(data)
      })
    },
  )
  await kit.openPanel("terminal", true)
  await expect.poll(() => connections.length).toBe(1)
  const connection = connections[0]!
  await connection.page.close({ code: 1000 })
  await connection.server.close({ code: 1000 })
  const panel = kit.page.getByRole("region", { name: "终端", exact: true })
  await expect(panel.getByRole("alert")).toContainText("MRK-1008")
  await panel.getByRole("button", { name: "重试", exact: true }).click()
  await expect.poll(() => connections.length).toBe(2)
  expect(new URL(connections[1]!.page.url()).pathname).toBe(new URL(connection.page.url()).pathname)
  await expect(panel.getByRole("alert")).toHaveCount(0)
  output.length = 0
  const script = path.join(kit.project, "output-retry.mjs")
  await writeFile(script, 'process.stdout.write("output-after-reconnection\\n")')
  await panel.click()
  await kit.page.keyboard.type(`node "${script}"`)
  await kit.page.keyboard.press("Enter")
  await expect.poll(() => output.join("")).toContain("output-after-reconnection")
})

test("a running terminal reconnects input after normal transport closure without replaying commands", async ({
  kit,
}) => {
  const connections: { page: WebSocketRoute; server: WebSocketRoute }[] = []
  await kit.page.routeWebSocket(
    (url) => url.pathname.endsWith("/connect") && url.searchParams.get("cursor") === "-1",
    (socket) => {
      connections.push({ page: socket, server: socket.connectToServer() })
    },
  )
  const marker = path.join(kit.project, "reconnected-input.txt")
  const script = path.join(kit.project, "reconnected-input.mjs")
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, process.argv[2] + "\\n")`,
  )
  const enter = async (value: string) => {
    await kit.page.getByRole("region", { name: "终端", exact: true }).click()
    await kit.page.keyboard.type(`node "${script}" ${value}`)
    await kit.page.keyboard.press("Enter")
  }
  await kit.openPanel("terminal", true)
  await enter("first")
  await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe("first\n")
  expect(connections).toHaveLength(1)
  const input = connections[0]!
  const endpoint = new URL(input.page.url())
  endpoint.pathname = endpoint.pathname.replace(/\/connect$/, "")
  endpoint.protocol = "http:"
  await input.page.close({ code: 1000, reason: "transport maintenance" })
  await input.server.close({ code: 1000, reason: "transport maintenance" })
  const info = await kit.page.evaluate(async (url) => {
    const response = await fetch(url)
    return { status: response.status, info: await response.json() }
  }, endpoint.href)
  expect(info.status).toBe(200)
  expect(info.info.status).toBe("running")
  expect(() => process.kill(info.info.pid, 0)).not.toThrow()
  await enter("second")
  await kit.openPanel("git")
  await kit.openPanel("terminal")
  await enter("third")
  await expect.poll(() => readFile(marker, "utf8")).toBe("first\nsecond\nthird\n")
  expect(connections).toHaveLength(2)
  await enter("fourth")
  await expect.poll(() => readFile(marker, "utf8")).toBe("first\nsecond\nthird\nfourth\n")
  await kit.panel().getByRole("button", { name: "关闭 终端", exact: true }).click()
  await expect.poll(() => kit.page.evaluate(async (url) => (await fetch(url)).status, endpoint.href)).toBe(404)
  await expect
    .poll(() => {
      try {
        process.kill(info.info.pid, 0)
        return true
      } catch {
        return false
      }
    })
    .toBe(false)
})

test("retrying terminal creation retains a submitted command and runs it once", async ({ kit }) => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let failed = false
  await kit.page.route("**/pty", async (route) => {
    if (route.request().method() === "POST" && !failed) {
      failed = true
      entered.resolve()
      await release.promise
      return route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
    }
    await route.continue()
  })
  const marker = path.join(kit.project, "retried-input.txt")
  const script = path.join(kit.project, "retried-input.mjs")
  await writeFile(script, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "once")`)
  try {
    await kit.openPanel("terminal", true)
    await entered.promise
    await kit.page.getByRole("region", { name: "终端", exact: true }).click()
    await kit.page.keyboard.type(`node "${script}"`)
    await kit.page.keyboard.press("Enter")
    release.resolve()
    await kit.panel().getByRole("button", { name: "重试", exact: true }).click()
    await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe("once")
    await kit.openPanel("git")
    await kit.openPanel("terminal")
    expect(await readFile(marker, "utf8")).toBe("once")
  } finally {
    release.resolve()
  }
})

for (const revisit of [false, true])
  test(
    revisit
      ? "startup commands keep their order across terminal remounts"
      : "a submitted startup command runs after its terminal view is unmounted",
    async ({ kit }) => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      await kit.page.route("**/pty", async (route) => {
        if (route.request().method() === "POST") {
          entered.resolve()
          await release.promise
        }
        await route.continue()
      })
      const marker = path.join(kit.project, "background-input.txt")
      const script = path.join(kit.project, "background-input.mjs")
      await writeFile(
        script,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "complete")`,
      )
      try {
        await kit.openPanel("terminal", true)
        await entered.promise
        await kit.page.getByRole("region", { name: "终端", exact: true }).click()
        await kit.page.keyboard.type(`node "${script}"`)
        await kit.page.keyboard.press("Enter")
        await kit.openPanel("git")
        if (revisit) {
          const next = path.join(kit.project, "dependent-input.mjs")
          await writeFile(
            next,
            `import { readFileSync, writeFileSync } from "node:fs"; if (readFileSync(${JSON.stringify(marker)}, "utf8") !== "complete") throw new Error("first command missing"); writeFileSync(${JSON.stringify(marker)}, "complete second")`,
          )
          await kit.openPanel("terminal")
          await kit.page.getByRole("region", { name: "终端", exact: true }).click()
          await kit.page.keyboard.type(`node "${next}"`)
          await kit.page.keyboard.press("Enter")
        }
        release.resolve()
        await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe(revisit ? "complete second" : "complete")
      } finally {
        release.resolve()
      }
    },
  )

test("Unicode commands typed during terminal startup stay out of the conversation and run intact", async ({ kit }) => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await kit.page.route("**/pty", async (route) => {
    if (route.request().method() === "POST") {
      entered.resolve()
      await release.promise
    }
    await route.continue()
  })
  const marker = path.join(kit.project, "early-input.txt")
  const script = path.join(kit.project, "启动任务.mjs")
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "complete")`,
  )
  try {
    await kit.openPanel("terminal", true)
    await entered.promise
    await kit.page.getByRole("region", { name: "终端", exact: true }).click()
    await kit.page.keyboard.type(`node "${script}"`)
    await expect(kit.page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("")
    await kit.page.keyboard.press("Enter")
    release.resolve()
    await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe("complete")
    await expect(kit.page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("")
  } finally {
    release.resolve()
  }
})

for (const cancel of [false, true])
  test(
    cancel
      ? "terminal readiness preserves input after a native composition is cancelled"
      : "terminal readiness preserves an unfinished native input composition",
    async ({ kit }) => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      await kit.page.route("**/pty", async (route) => {
        if (route.request().method() === "POST") {
          entered.resolve()
          await release.promise
        }
        await route.continue()
      })
      const marker = path.join(kit.project, "composed-input.txt")
      const script = path.join(kit.project, "启动任务.mjs")
      await writeFile(
        script,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "complete")`,
      )
      const cdp = await kit.page.context().newCDPSession(kit.page)
      try {
        await kit.openPanel("terminal", true)
        await entered.promise
        await kit.page.getByRole("region", { name: "终端", exact: true }).click()
        await kit.page.keyboard.type(`node "${kit.project}${path.sep}`)
        await cdp.send("Input.imeSetComposition", { text: "启", selectionStart: 1, selectionEnd: 1 })
        const created = kit.page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/pty" && response.request().method() === "POST",
        )
        release.resolve()
        await created
        await kit.page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        )
        if (cancel) await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 })
        await cdp.send("Input.insertText", { text: "启动任务" })
        await kit.page.keyboard.type('.mjs"')
        await kit.page.keyboard.press("Enter")
        await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe("complete")
        await expect(kit.page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("")
      } finally {
        release.resolve()
        await cdp.detach()
      }
    },
  )

test("terminal startup does not take focus from a conversation the user is editing", async ({ kit }) => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await kit.page.route("**/pty", async (route) => {
    if (route.request().method() === "POST") {
      entered.resolve()
      await release.promise
    }
    await route.continue()
  })
  try {
    await kit.openPanel("terminal", true)
    await entered.promise
    const composer = kit.page.getByRole("textbox", { name: "消息", exact: true })
    await composer.fill("keep editing")
    release.resolve()
    await kit.page.getByRole("textbox", { name: "Terminal input", exact: true }).last().waitFor()
    await expect(composer).toBeFocused()
    await kit.page.keyboard.type(" here")
    await expect(composer).toHaveValue("keep editing here")
  } finally {
    release.resolve()
  }
})
