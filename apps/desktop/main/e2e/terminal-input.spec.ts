import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"
import type { WebSocketRoute } from "@playwright/test"
import { connect } from "@merakcode/sdk"

test("a closed terminal output connection offers retry and reconnects the same running process", async ({ kit }) => {
  const connections: { page: WebSocketRoute; server: WebSocketRoute }[] = []
  const output: string[] = []
  await kit.page.routeWebSocket(
    (url) => url.pathname.startsWith("/terminal/") && url.searchParams.get("cursor") === "0",
    (socket) => {
      const server = socket.connectToServer()
      connections.push({ page: socket, server })
      server.onMessage((data) => {
        output.push(typeof data === "string" ? data : data.toString())
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
  await expect(panel.getByRole("alert")).toContainText("MRK-4028")
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
    (url) => url.pathname.startsWith("/terminal/"),
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
  // One connection shows the output, the other carries the keys
  expect(connections).toHaveLength(2)
  const input = connections[1]!
  const engine = await connect(JSON.parse(await readFile(path.join(kit.root, "data", "engine.json"), "utf8")))
  const id = decodeURIComponent(new URL(input.page.url()).pathname.split("/").at(-1)!)
  await input.page.close({ code: 1000, reason: "transport maintenance" })
  await input.server.close({ code: 1000, reason: "transport maintenance" })
  const info = await engine.terminal.get({ id })
  expect(info.status).toBe("running")
  expect(() => process.kill(info.pid, 0)).not.toThrow()
  await enter("second")
  await kit.openPanel("git")
  await kit.openPanel("terminal")
  await enter("third")
  await expect.poll(() => readFile(marker, "utf8")).toBe("first\nsecond\nthird\n")
  await enter("fourth")
  await expect.poll(() => readFile(marker, "utf8")).toBe("first\nsecond\nthird\nfourth\n")
  await kit.panel().getByRole("button", { name: "关闭 终端", exact: true }).click()
  await expect.poll(async () => (await engine.terminal.list({ directory: kit.project }))?.length).toBe(0)
  await engine.close()
  await expect
    .poll(() => {
      try {
        process.kill(info.pid, 0)
        return true
      } catch {
        return false
      }
    })
    .toBe(false)
})

test("retrying terminal creation retains a submitted command and runs it once", async ({ kit }) => {
  const rpc = await kit.rpc()
  const creating = rpc.hold("terminal.create", { times: 1 })
  rpc.fail("terminal.create", "MRK-1001")
  const marker = path.join(kit.project, "retried-input.txt")
  const script = path.join(kit.project, "retried-input.mjs")
  await writeFile(script, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "once")`)
  try {
    await kit.openPanel("terminal", true)
    await creating.entered
    await kit.page.getByRole("region", { name: "终端", exact: true }).click()
    await kit.page.keyboard.type(`node "${script}"`)
    await kit.page.keyboard.press("Enter")
    creating.release()
    await kit.panel().getByRole("button", { name: "重试", exact: true }).click()
    await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe("once")
    await kit.openPanel("git")
    await kit.openPanel("terminal")
    expect(await readFile(marker, "utf8")).toBe("once")
  } finally {
    creating.release()
  }
})

for (const revisit of [false, true])
  test(
    revisit
      ? "startup commands keep their order across terminal remounts"
      : "a submitted startup command runs after its terminal view is unmounted",
    async ({ kit }) => {
      const rpc = await kit.rpc()
      const creating = rpc.hold("terminal.create", { times: 1 })
      const marker = path.join(kit.project, "background-input.txt")
      const script = path.join(kit.project, "background-input.mjs")
      await writeFile(
        script,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "complete")`,
      )
      try {
        await kit.openPanel("terminal", true)
        await creating.entered
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
        creating.release()
        await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe(revisit ? "complete second" : "complete")
      } finally {
        creating.release()
      }
    },
  )

test("Unicode commands typed during terminal startup stay out of the conversation and run intact", async ({ kit }) => {
  const rpc = await kit.rpc()
  const creating = rpc.hold("terminal.create", { times: 1 })
  const marker = path.join(kit.project, "early-input.txt")
  const script = path.join(kit.project, "启动任务.mjs")
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "complete")`,
  )
  try {
    await kit.openPanel("terminal", true)
    await creating.entered
    await kit.page.getByRole("region", { name: "终端", exact: true }).click()
    await kit.page.keyboard.type(`node "${script}"`)
    await expect(kit.page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("")
    await kit.page.keyboard.press("Enter")
    creating.release()
    await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe("complete")
    await expect(kit.page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("")
  } finally {
    creating.release()
  }
})

for (const cancel of [false, true])
  test(
    cancel
      ? "terminal readiness preserves input after a native composition is cancelled"
      : "terminal readiness preserves an unfinished native input composition",
    async ({ kit }) => {
      const rpc = await kit.rpc()
      const creating = rpc.hold("terminal.create", { times: 1 })
      const marker = path.join(kit.project, "composed-input.txt")
      const script = path.join(kit.project, "启动任务.mjs")
      await writeFile(
        script,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "complete")`,
      )
      const cdp = await kit.page.context().newCDPSession(kit.page)
      try {
        await kit.openPanel("terminal", true)
        await creating.entered
        await kit.page.getByRole("region", { name: "终端", exact: true }).click()
        await kit.page.keyboard.type(`node "${kit.project}${path.sep}`)
        await cdp.send("Input.imeSetComposition", { text: "启", selectionStart: 1, selectionEnd: 1 })
        creating.release()
        // The terminal exists in the engine once the held creation was answered
        const engine = await connect(JSON.parse(await readFile(path.join(kit.root, "data", "engine.json"), "utf8")))
        try {
          await expect.poll(async () => (await engine.terminal.list({ directory: kit.project }))?.length).toBe(1)
        } finally {
          await engine.close()
        }
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
        creating.release()
        await cdp.detach()
      }
    },
  )

test("terminal startup does not take focus from a conversation the user is editing", async ({ kit }) => {
  const rpc = await kit.rpc()
  const creating = rpc.hold("terminal.create", { times: 1 })
  try {
    await kit.openPanel("terminal", true)
    await creating.entered
    const composer = kit.page.getByRole("textbox", { name: "消息", exact: true })
    await composer.fill("keep editing")
    creating.release()
    await kit.page.getByRole("textbox", { name: "Terminal input", exact: true }).last().waitFor()
    await expect(composer).toBeFocused()
    await kit.page.keyboard.type(" here")
    await expect(composer).toHaveValue("keep editing here")
  } finally {
    creating.release()
  }
})
