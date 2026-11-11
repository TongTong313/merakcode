import { _electron, expect, test } from "@playwright/test"
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { connect } from "@merakcode/sdk"
import { bundle } from "../script/build"
import { stopEngine } from "./fixture"
import { build } from "esbuild"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("the engine is a background process: it outlives the app, the next start joins it, and the menu stops it", async () => {
  const main = path.resolve(import.meta.dirname, "..")
  const repo = path.resolve(main, "../../..")
  const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  await promisify(execFile)(
    "go",
    ["build", "-o", path.join("dist", target, process.platform === "win32" ? "merak.exe" : "merak"), "./cmd/merak"],
    { cwd: path.join(repo, "merak") },
  )
  await bundle()
  const home = await mkdtemp(path.join(tmpdir(), "merak-desktop-lifecycle-"))
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" })
      response.end("<h1>Engine lifecycle</h1>")
      return
    }
    for await (const _ of request) {
      /* Consume the model request. */
    }
    requested.resolve()
    await release.promise
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(
      'data: {"choices":[{"delta":{"content":"Background finished"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing local fixture port")
  const modelURL = `http://127.0.0.1:${address.port}`
  const launch = () =>
    _electron.launch({
      executablePath: createRequire(import.meta.url)("electron") as string,
      args: [
        main,
        `--user-data-dir=${path.join(home, "electron")}`,
        ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
      ],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined),
        ),
        MERAKCODE_HOME: home,
        MERAKCODE_APP_DEV_URL: modelURL,
        MERAKCODE_DISABLE_AUTOUPDATE: "1",
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: modelURL,
      },
    })
  const app = await launch()
  let observer: Awaited<ReturnType<typeof connect>> | undefined
  const appProcess = app.process()
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole("heading", { name: "Engine lifecycle" })).toBeVisible()
    const browser = await build({
      stdin: {
        contents:
          'export * from "@merakcode/sdk"; export { client as rendererClient } from "../renderer/src/state/client"; export * as rendererStore from "../renderer/src/state/store"',
        resolveDir: main,
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "MerakSDK",
      write: false,
    })
    await page.addScriptTag({ content: browser.outputFiles[0]!.text })
    const handshake = await page.evaluate(async () => {
      const api = (globalThis as unknown as { MerakSDK: typeof import("@merakcode/sdk") }).MerakSDK
      const client = await api.connect({ endpoint: `ws://${location.host}/rpc`, approve: true })
      const config = await client.config.get()
      const models = await client.model.list()
      await client.close()
      const renderer = (
        globalThis as unknown as {
          MerakSDK: { rendererClient: typeof import("../../renderer/src/state/client").client }
        }
      ).MerakSDK
      const first = await renderer.rendererClient()
      const second = await renderer.rendererClient()
      if (first !== second) throw new Error("Renderer opened more than one connection")
      const configuration = await first.config.get()
      if (!configuration.providers?.openai?.hasKey) throw new Error("Renderer configuration missing")
      await first.close()
      return {
        protocol: client.hello.protocol,
        provider: config.providers?.openai?.hasKey,
        models: models?.length ?? 0,
      }
    })
    expect(handshake).toMatchObject({ protocol: 1, provider: true })
    expect(handshake.models).toBeGreaterThan(0)
    const info = JSON.parse(await readFile(path.join(home, "data", "engine.json"), "utf8"))
    observer = await connect(info)
    const session = await observer.session.create({ provider: "openai", model: "gpt-4o", workdir: home })
    await page.evaluate(async (id) => {
      const store = (
        globalThis as unknown as { MerakSDK: { rendererStore: typeof import("../../renderer/src/state/store") } }
      ).MerakSDK.rendererStore
      store.connect()
      await store.bootstrap()
      await store.ensureSession(id)
    }, session.session)
    const finished = Promise.withResolvers<void>()
    await observer.events.subscribe({ scope: { session: session.session }, types: ["turn.finished"] }, () =>
      finished.resolve(),
    )
    await observer.session.send({ session: session.session, parts: [{ text: "Continue while hidden" }] })
    await requested.promise
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((win) => !win.isVisible())),
    ).toBe(true)
    release.resolve()
    await finished.promise
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const store = (
            globalThis as unknown as { MerakSDK: { rendererStore: typeof import("../../renderer/src/state/store") } }
          ).MerakSDK.rendererStore
          return store.state.views[id]?.state.messages?.at(-1)?.parts?.[0]?.text
        }, session.session),
      )
      .toBe("Background finished")
    // Quitting the app leaves the engine running, with the work it did
    await app
      .evaluate(({ app }) => {
        app.quit()
        app.quit()
      })
      .catch(() => {})
    await expect.poll(() => appProcess.exitCode, { timeout: 15000 }).toBe(0)
    expect(alive(info.pid)).toBe(true)
    const stored = await observer.events.find({ scope: { session: session.session }, types: ["message.completed"] })
    expect(stored).toHaveLength(1)

    // The next start joins the same engine and finds the session
    const again = await launch()
    const againProcess = again.process()
    try {
      const window = await again.firstWindow()
      await expect(window.getByRole("heading", { name: "Engine lifecycle" })).toBeVisible()
      expect(JSON.parse(await readFile(path.join(home, "data", "engine.json"), "utf8")).pid).toBe(info.pid)
      expect((await observer.session.list())?.map((item) => item.id)).toContain(session.session)
      // "Stop background engine and quit" ends the engine, then the app
      await again
        .evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("stop-engine")!.click())
        .catch(() => {})
      await expect.poll(() => againProcess.exitCode, { timeout: 30000 }).toBe(0)
      await expect.poll(() => alive(info.pid), { timeout: 15000 }).toBe(false)
      await expect(access(path.join(home, "data", "engine.json"))).rejects.toThrow()
    } finally {
      await again.close().catch(() => {})
    }
  } finally {
    release.resolve()
    await observer?.close()
    await app.close().catch(() => {})
    await stopEngine(home)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true, maxRetries: 5 })
  }
})
