import { createServer } from "node:http"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

test.use({ script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) } })

test("terminal exit preserves a redirected browser after panel cache eviction", async ({ kit }) => {
  test.setTimeout(240_000)
  const redirect = Promise.withResolvers<void>()
  const server = createServer((request, response) => {
    if (request.url === "/wait") {
      void redirect.promise.then(() => response.end("ready"))
      return
    }
    response.setHeader("content-type", "text/html")
    response.end(
      request.url === "/old"
        ? '<!doctype html><title>Old page</title><script>fetch("/wait").then(() => location.replace("/new"))</script>'
        : "<!doctype html><title>Final page</title>Final address",
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const release = path.join(kit.project, "release-terminal")
  const script = path.join(kit.project, "wait-terminal.mjs")
  await writeFile(
    script,
    `import { existsSync } from "node:fs"; setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(0) }, 100)`,
  )
  try {
    await kit.send("cache owner")
    await expect(kit.text("Reply: cache owner")).toBeVisible()
    const sessionID = new URL(kit.page.url()).pathname.split("/").at(-1)!
    await kit.openPanel("terminal")
    await kit.page.locator(".terminal-host textarea").focus()
    await kit.page.keyboard.type(`node "${script}"; exit`)
    await kit.page.keyboard.press("Enter")
    await kit.openPanel("browser")
    await kit.panel().getByRole("textbox", { name: "地址" }).fill(`${base}/old`)
    await kit.panel().getByRole("textbox", { name: "地址" }).press("Enter")
    await expect(kit.panel().getByRole("tab", { name: "Old page", exact: true })).toBeVisible()
    for (let index = 0; index < 34; index++) {
      await kit.page
        .getByRole("navigation", { name: "对话" })
        .getByRole("button", { name: "新对话", exact: true })
        .click()
      await expect(kit.page.getByRole("heading", { name: "要在 project 里做什么？", exact: true })).toBeVisible()
      await kit.send(`cache other ${index}`)
      await expect(kit.text(`Reply: cache other ${index}`)).toBeVisible()
    }
    const readLayout = () =>
      kit.app.evaluate(({ app }, owner) => {
        const fs = process.getBuiltinModule("fs")
        const path = process.getBuiltinModule("path")
        const bucket = `panels-${Buffer.from(owner).toString("base64url")}.json`
        return JSON.parse(
          JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "storage", bucket), "utf8")).layout,
        )
      }, sessionID)
    redirect.resolve()
    await expect
      .poll(async () => (await readLayout()).tabs.find((tab: { kind: string }) => tab.kind === "browser")?.url)
      .toBe(`${base}/new`)
    await writeFile(release, "exit")
    await expect
      .poll(async () => (await readLayout()).tabs.find((tab: { kind: string }) => tab.kind === "terminal")?.view?.ended)
      .toBe(true)
    const result = await readLayout()
    expect(result.tabs.find((tab: { kind: string }) => tab.kind === "browser")?.url).toBe(`${base}/new`)
    await kit.restart(true)
    await kit.page.locator(`a[href$="/session/${sessionID}"]`).click()
    await expect(kit.panel().getByRole("textbox", { name: "地址" })).toHaveValue(`${base}/new`)
    await expect(kit.panel().getByRole("tab", { name: "Final page", exact: true })).toBeVisible()
  } finally {
    redirect.resolve()
    await writeFile(release, "exit")
    server.closeAllConnections()
    server.close()
  }
})
