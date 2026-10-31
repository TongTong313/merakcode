/** Launch the production app without relying on the Node inspector, which the release fuses disable. */
import { chromium, expect } from "@playwright/test"
import { spawn } from "node:child_process"
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { seedCatalog } from "../../../../script/node/seed-catalog"

const release = path.resolve(import.meta.dirname, "../release")
const directory =
  process.platform === "win32"
    ? "win-unpacked"
    : process.platform === "darwin"
      ? `mac${process.arch === "arm64" ? "-arm64" : ""}`
      : "linux-unpacked"
const executable = path.join(
  release,
  directory,
  process.platform === "win32"
    ? "MerakCode.exe"
    : process.platform === "darwin"
      ? "MerakCode.app/Contents/MacOS/MerakCode"
      : "merakcode-desktop",
)
const root = await mkdtemp(path.join(os.tmpdir(), "merakcode-packaged-smoke-"))
const mainPrompts = new Set<string>()
let phase = "startup"
const diagnostics: string[] = []
const failMain = process.argv.includes("--fail-main")
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const body = JSON.parse(Buffer.concat(chunks).toString()) as {
    tools?: unknown[]
    messages?: { role: string; content: unknown }[]
  }
  const main = !!body.tools?.length
  const user = body.messages?.findLast((message) => message.role === "user")?.content
  const prompt =
    typeof user === "string"
      ? user
      : Array.isArray(user)
        ? user.map((part: { text?: string }) => part.text ?? "").join("")
        : ""
  if (main) mainPrompts.add(prompt)
  if (failMain && main) {
    response.writeHead(400, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: "SMOKE_MAIN_FAILURE", type: "invalid_request_error" } }))
    return
  }
  const content = main
    ? prompt.includes("keyboard marker")
      ? "PACKAGED_SMOKE_ENTER_OK"
      : "PACKAGED_SMOKE_OK"
    : failMain
      ? "PACKAGED_SMOKE_OK"
      : "PACKAGED_SMOKE_TITLE"
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end(
    `data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  )
})
let child: ReturnType<typeof spawn> | undefined
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
try {
  await seedCatalog(root)
  const require = createRequire(import.meta.url)
  await cp(path.dirname(require.resolve("zod")), path.join(root, "node_modules/zod"), { recursive: true })
  const project = path.join(root, "project")
  await mkdir(project)
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve))
  const port = (model.address() as AddressInfo).port
  await writeFile(
    path.join(root, "merakcode.json"),
    JSON.stringify({
      model: "alibaba-cn/qwen-plus",
      small_model: "alibaba-cn/qwen-plus",
      enabled_providers: ["alibaba-cn"],
      provider: { "alibaba-cn": { options: { apiKey: "smoke", baseURL: `http://127.0.0.1:${port}/v1` } } },
      memory: { auto_extract: false, auto_recall: false, session_memory: false, auto_dream: false },
      lsp: false,
      locale: "en-US",
    }),
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "ELECTRON_RUN_AS_NODE" && !/_API_KEY$/i.test(name)),
  )
  child = spawn(
    executable,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${path.join(root, "electron")}`,
      ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
      `merakcode://open-project?directory=${encodeURIComponent(project)}`,
    ],
    {
      env: {
        ...env,
        MERAKCODE_HOME: root,
        MERAKCODE_DISABLE_AUTOUPDATE: "1",
        MERAKCODE_DISABLE_CATALOG_FETCH: "1",
        MERAKCODE_SANDBOX_MODE: "off",
        MERAKCODE_DISABLE_LSP_DOWNLOAD: "1",
        MERAKCODE_DISABLE_EXTERNAL_SKILLS: "1",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Packaged app did not open its browser endpoint")), 60_000)
    let output = ""
    function finish(value: string | Error) {
      clearTimeout(timer)
      child!.stdout!.off("data", collect)
      child!.stderr!.off("data", collect)
      child!.off("error", failed)
      child!.off("exit", exited)
      if (typeof value === "string") resolve(value)
      else reject(new Error(`${value.message}\n${output.slice(-8000)}`))
    }
    function collect(chunk: Buffer) {
      output = (output + chunk.toString()).slice(-16000)
      const url = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/.exec(output)?.[1]
      if (url) finish(url)
    }
    function failed(error: Error) {
      finish(error)
    }
    function exited(code: number | null) {
      finish(new Error(`Packaged app exited before startup: ${code}`))
    }
    child!.stdout!.on("data", collect)
    child!.stderr!.on("data", collect)
    child!.once("error", failed)
    child!.once("exit", exited)
  })
  child.stdout!.resume()
  child.stderr!.resume()
  browser = await chromium.connectOverCDP(endpoint)
  const context = browser.contexts()[0]!
  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 60_000 }))
  page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`))
  page.on("requestfailed", (request) =>
    diagnostics.push(`requestfailed: ${new URL(request.url()).pathname} ${request.failure()?.errorText}`),
  )
  await page.evaluate(() => {
    const keys: { key: string; code: number; composing: boolean }[] = []
    ;(window as unknown as { __smokeKeys: typeof keys }).__smokeKeys = keys
    document.addEventListener(
      "keydown",
      (event) => keys.push({ key: event.key, code: event.keyCode, composing: event.isComposing }),
      true,
    )
  })
  const input = page
    .getByRole("textbox", { name: /^(消息|Message)$/ })
    .filter({ visible: true })
    .first()
  const later = page.getByRole("button", { name: /^(跳过|Skip)$/ })
  await input.or(later).first().waitFor({ timeout: 120_000 })
  if (await later.isVisible()) await later.click()
  // Exercise cold-start Enter; the negative control isolates the title-versus-reply oracle through Send.
  const methods = failMain ? (["button"] as const) : (["keyboard", "button"] as const)
  for (const [index, method] of methods.entries()) {
    if (index)
      await page
        .getByRole("navigation", { name: /^(对话|Conversations)$/ })
        .getByRole("button", { name: /^(新对话|New conversation)$/ })
        .click()
    const initialURL = page.url()
    phase = `${method}:submit`
    const prompt = method === "button" ? "Reply with the smoke marker" : "Reply with the keyboard marker"
    await page.bringToFront()
    await input.click()
    await input.fill(prompt)
    await expect(input).toHaveValue(prompt)
    if (method === "button") await page.getByRole("button", { name: /^(发送|Send)$/, exact: true }).click()
    else await input.press("Enter")
    phase = `${method}:session`
    await expect(page).not.toHaveURL(initialURL, { timeout: 30_000 })
    phase = `${method}:reply`
    if (failMain)
      await expect(page.getByRole("navigation").getByText("PACKAGED_SMOKE_OK", { exact: true })).toBeVisible({
        timeout: 30_000,
      })
    const log = page.getByRole("log", { name: /^(消息记录|Messages)$/ })
    const reply = log
      .getByText(method === "button" ? "PACKAGED_SMOKE_OK" : "PACKAGED_SMOKE_ENTER_OK", { exact: true })
      .filter({ visible: true })
      .last()
    const error = log.getByRole("alert").filter({ visible: true }).first()
    await reply.or(error).first().waitFor({ timeout: 60_000 })
    if (await error.isVisible()) throw new Error(`Main reply failed during ${phase}`)
    await expect(reply).toBeVisible()
    await expect.poll(() => mainPrompts.has(prompt)).toBe(true)
    await expect(page.getByRole("button", { name: /^(停止|Stop)$/, exact: true })).toHaveCount(0)
  }
  phase = "shutdown"
  await context.tracing.stop()
  // Closing the last window does not quit on macOS. CDP Browser.close uses the app's normal quit lifecycle.
  await context
    .newCDPSession(page)
    .then((session) => session.send("Browser.close"))
    .catch(() => undefined)
  await new Promise<void>((resolve, reject) => {
    if (child!.exitCode !== null)
      return child!.exitCode === 0 ? resolve() : reject(new Error(`Packaged app exited with ${child!.exitCode}`))
    const timer = setTimeout(() => reject(new Error("Packaged app did not exit after closing")), 30_000)
    child!.once("exit", (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error(`Packaged app exited with ${code}`))
    })
  })
  process.stdout.write(`Packaged desktop passed: ${process.platform}-${process.arch}\n`)
} catch (error) {
  const output = path.join(release, "smoke-results", failMain ? "negative-control" : "main")
  await mkdir(output, { recursive: true })
  await browser
    ?.contexts()[0]
    ?.pages()[0]
    ?.screenshot({ path: path.join(output, "failure.png") })
    .catch(() => undefined)
  await cp(path.join(root, "logs"), path.join(output, "logs"), { recursive: true }).catch(() => undefined)
  const page = browser?.contexts()[0]?.pages()[0]
  const state = await page
    ?.evaluate(() => ({
      focused: document.hasFocus(),
      active: document.activeElement?.tagName,
      keys: (window as unknown as { __smokeKeys?: unknown }).__smokeKeys,
    }))
    .catch(() => undefined)
  await browser
    ?.contexts()[0]
    ?.tracing.stop({ path: path.join(output, "trace.zip") })
    .catch(() => undefined)
  await writeFile(
    path.join(output, "error.txt"),
    `${phase}\n${String(error)}\n${JSON.stringify({ diagnostics, state, mainRequests: mainPrompts.size })}`,
  )
  throw error
} finally {
  await browser?.close().catch(() => undefined)
  if (child?.pid && child.exitCode === null) {
    if (process.platform === "win32") {
      const kill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      await new Promise<void>((resolve) => {
        kill.once("error", () => resolve())
        kill.once("exit", () => resolve())
      })
    } else child.kill("SIGKILL")
  }
  await new Promise<void>((resolve) => model.close(() => resolve()))
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
}
