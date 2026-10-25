/**
 * Desktop end-to-end fixture: Playwright launches the real desktop app (Electron main process, bundled engine and
 * UI). All data directories are isolated in a temp directory, and the model is a local fake server (OpenAI-compatible
 * streaming), so no network access or cost.
 *
 * In development the desktop app runs the apps/cli sources as the engine with node from PATH, so build the main
 * process and the UI first:
 *   pnpm build && pnpm --dir ../renderer build
 */
import {
  test as base,
  expect,
  _electron,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test"
import { createServer, type Server } from "node:http"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { seedCatalog } from "../../../../script/node/seed-catalog.ts"

/** One fake model reply: text, or a tool call (the model is asked again once the tool result is back) */
type Reply = { text: string } | { tool: string; args: Record<string, unknown> }

/**
 * Fake model: picks a reply from the latest user message, the tool results so far in this turn, the system prompt and
 * the requested model. Returning a pending Promise keeps the turn running.
 */
export type Script = (input: {
  prompt: string
  toolResults: string[]
  system: string
  model: string
}) => Reply | Promise<Reply>

export type Kit = {
  app: ElectronApplication
  page: Page
  project: string
  /** Isolated data root; the global config is config/merakcode/merakcode.json */
  root: string
  /** Number of requests the fake model received */
  requests: () => number
  /** Fake model URL (OpenAI-compatible, up to /v1) */
  modelURL: string
  send: (text: string) => Promise<void>
  /** Last visible occurrence of the text on the page (the message list may hold hidden copies) */
  text: (value: string | RegExp) => Locator
  /** Switches the permission mode with the dropdown next to the input */
  mode: (name: RegExp) => Promise<void>
  /** Permission mode button next to the input, showing the current mode */
  modeButton: () => Locator
  /** Approval bar */
  approval: () => Locator
  /** Opens settings, optionally a given section */
  settings: (section?: RegExp) => Promise<void>
  /** Right-hand side panel */
  panel: () => Locator
  /** Runs git in the project directory */
  git: (...args: string[]) => string
}

const main = path.resolve(import.meta.dirname, "..")
const electron = createRequire(path.join(main, "package.json"))("electron") as unknown as string

type Message = { role: string; content?: unknown }

const text = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: string }) => part.text ?? "").join("")
      : ""

/** OpenAI-compatible streaming reply */
function stream(reply: Reply) {
  const delta =
    "text" in reply
      ? { role: "assistant", content: reply.text }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${Math.random().toString(36).slice(2)}`,
              type: "function",
              function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
            },
          ],
        }
  return [
    { id: "e2e", object: "chat.completion.chunk", choices: [{ index: 0, delta }] },
    {
      id: "e2e",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "text" in reply ? "stop" : "tool_calls" }],
      // Fixed usage; the context usage shown in the UI is computed from it
      usage: { prompt_tokens: 13_000, completion_tokens: 100, total_tokens: 13_100 },
    },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")
    .concat("data: [DONE]\n\n")
}

async function model(script: Script) {
  let count = 0
  const server: Server = createServer(async (request, response) => {
    if (request.method === "GET" && (request.url ?? "").includes("/models")) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "e2e-relay", context_length: 32_000, max_output_tokens: 1_024 }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { messages?: Message[]; model?: string }
    const messages = body.messages ?? []
    const user = messages.findLastIndex((message) => message.role === "user")
    const prompt = text(messages[user]?.content)
    const toolResults = messages
      .slice(user + 1)
      .flatMap((message) => (message.role === "tool" ? [text(message.content)] : []))
    const system = messages.flatMap((message) => (message.role === "system" ? [text(message.content)] : [])).join("\n")
    count++
    // Background requests without tools (titles, summaries) always get a short text
    const reply = (body as { tools?: unknown[] }).tools?.length
      ? await script({ prompt, toolResults, system, model: body.model ?? "" })
      : { text: "E2E" }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(stream(reply))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("model server has no port")
  return { url: `http://127.0.0.1:${address.port}/v1`, count: () => count, close: () => server.close() }
}

/**
 * Startup never reached the input: attaches what the window showed and what the app logged. The failure happens
 * inside this fixture, before Playwright's own failure screenshot, and the logs stay in the runner's temp directory.
 */
async function evidence(page: Page, root: string, output: string[], info: TestInfo) {
  const shot = await page.screenshot().catch(() => undefined)
  if (shot) await info.attach("startup-screenshot", { body: shot, contentType: "image/png" })
  const shown = await page
    .evaluate(() => `${location.href}\n\n${document.body?.innerText ?? ""}`)
    .catch((error: Error) => `page unavailable: ${error.message}`)
  await info.attach("startup-page", {
    body: `${shown}\n\n--- console ---\n${output.join("\n")}`,
    contentType: "text/plain",
  })
  const logs = path.join(root, "logs")
  const files = await readdir(logs, { recursive: true }).catch(() => [] as string[])
  for (const file of files.filter((name) => name.endsWith(".ndjson"))) {
    const text = await readFile(path.join(logs, file), "utf8").catch(() => "")
    const tail = text.split("\n").slice(-400).join("\n")
    await info.attach(`log-${file.replaceAll(/[\\/]/g, "_")}`, { body: tail, contentType: "text/plain" })
  }
}

export const test = base.extend<{
  script: { reply: Script }
  config: Record<string, unknown>
  /** The project is a git repository with notes.txt committed */
  git: boolean
  kit: Kit
}>({
  // Wrapped in an object because Playwright treats a bare function as a fixture function
  script: [{ reply: () => ({ text: "OK" }) }, { option: true }],
  config: [{}, { option: true }],
  git: [false, { option: true }],
  kit: async ({ script, config, git }, use, info) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "merakcode-desktop-e2e-"))
    await seedCatalog(root)
    const project = path.join(root, "project")
    await mkdir(project, { recursive: true })
    await writeFile(path.join(project, "notes.txt"), "hello from e2e\n")
    // The app refreshes git diffs in the background, and git diff briefly holds .git/index.lock while it caches file
    // stats (it ignores GIT_OPTIONAL_LOCKS); a test's own git command that meets it fails, so it tries again
    const run = (...args: string[]): string => {
      for (let attempt = 1; ; attempt++) {
        try {
          return execFileSync("git", args, { cwd: project, encoding: "utf8" })
        } catch (error) {
          if (attempt >= 20 || !(error instanceof Error) || !error.message.includes("index.lock")) throw error
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
        }
      }
    }
    if (git) {
      run("init", "--quiet")
      // A global autocrlf would check files out with CRLF, while assertions expect LF
      run("config", "core.autocrlf", "false")
      run("config", "user.name", "MerakCode E2E")
      run("config", "user.email", "e2e@merakcode.invalid")
      run("add", ".")
      run("commit", "--quiet", "-m", "init")
    }
    const fake = await model(script.reply)
    await writeFile(
      path.join(root, "merakcode.json"),
      JSON.stringify({
        model: "alibaba-cn/qwen-plus",
        small_model: "alibaba-cn/qwen-plus",
        enabled_providers: ["alibaba-cn"],
        provider: { "alibaba-cn": { options: { apiKey: "e2e", baseURL: fake.url } } },
        memory: { auto_extract: false, auto_recall: false, session_memory: false, auto_dream: false },
        lsp: false,
        // The renderer follows the OS language until this is set, and GitHub-hosted Windows is English. The tests
        // assert Chinese copy. bootstrap() applies the config before the splash goes away.
        locale: "zh-CN",
        ...config,
      }),
    )
    // Terminals such as VS Code's pass on ELECTRON_RUN_AS_NODE=1, which turns Electron into plain Node.
    // Local model keys (*_API_KEY) are dropped too, so only the fake model is used and the onboarding "no model
    // available" state can be tested.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[0] !== "ELECTRON_RUN_AS_NODE" && !/_API_KEY$/i.test(entry[0]) && entry[1] !== undefined,
      ),
    )
    const app = await _electron.launch({
      executablePath: electron,
      args: [
        main,
        `--user-data-dir=${path.join(root, "electron")}`,
        `merakcode://open-project?directory=${encodeURIComponent(project)}`,
      ],
      env: {
        ...env,
        MERAKCODE_HOME: root,
        MERAKCODE_DISABLE_AUTOUPDATE: "1",
        MERAKCODE_DISABLE_CATALOG_FETCH: "1",
        MERAKCODE_SANDBOX_MODE: "off",
        MERAKCODE_DISABLE_LSP_DOWNLOAD: "1",
        MERAKCODE_DISABLE_EXTERNAL_SKILLS: "1",
      },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    const output: string[] = []
    page.on("console", (message) => output.push(`[${message.type()}] ${message.text()}`))
    page.on("pageerror", (error) => output.push(`[pageerror] ${error.message}`))
    // Behavior spec shared by the old and new UI: locate only by role, accessible name and visible text, never by
    // class names or data-* attributes
    const input = () =>
      page
        .getByRole("textbox", { name: /^(消息|Message)$/ })
        .filter({ visible: true })
        .first()
    // Without an available model, onboarding opens first as a modal over the input: skip it
    const later = page.getByRole("button", { name: /^(跳过|Skip)$/ })
    await input()
      .or(later)
      .first()
      .waitFor({ timeout: 120_000 })
      .catch(async (error: unknown) => {
        await evidence(page, root, output, info)
        throw error
      })
    if (await later.isVisible().catch(() => false)) await later.click()
    await input().waitFor()
    const send = async (value: string) => {
      await input().click()
      await input().pressSequentially(value, { delay: 5 })
      await page.keyboard.press("Enter")
    }
    const text = (value: string | RegExp) => page.getByText(value).filter({ visible: true }).last()
    const mode = async (name: RegExp) => {
      await modeButton().click()
      await page.getByRole("option", { name }).click()
    }
    const modeButton = () =>
      page
        .getByRole("button", { name: /^(权限模式|Permission mode)/ })
        .filter({ visible: true })
        .first()
    const approval = () =>
      page
        .getByRole("region", { name: /^(审批|Approval)$/ })
        .filter({ visible: true })
        .last()
    const settings = async (section?: RegExp) => {
      await page
        .getByRole("button", { name: /^(设置|Settings)$/ })
        .filter({ visible: true })
        .first()
        .click()
      if (section) await page.getByText(section).filter({ visible: true }).first().click()
    }
    const panel = () => page.getByRole("complementary", { name: /^(右侧面板|Side panel)$/ })
    await use({
      app,
      page,
      project,
      root,
      requests: fake.count,
      modelURL: fake.url,
      send,
      text,
      mode,
      modeButton,
      approval,
      settings,
      panel,
      git: run,
    })
    await app.close().catch(() => undefined)
    fake.close()
    if (info.status !== info.expectedStatus) console.log("KEPT", root)
    else await rm(root, { recursive: true, force: true }).catch(() => undefined)
  },
})

export { expect }
