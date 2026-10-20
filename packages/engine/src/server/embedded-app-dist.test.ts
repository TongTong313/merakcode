// The injection point of the embedded session UI (Server.configureEmbeddedAppDist): injected files are served as an
// SPA, and without injection the engine neither embeds a UI nor looks for directories in the repository.
import { afterEach, describe, expect, test } from "vitest"
import { existsSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Server } from "./server"
import { Filesystem } from "@merakcode/util/filesystem"

afterEach(() => Server.configureEmbeddedAppDist(undefined))

async function files() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "embedded-app-dist-"))
  await Filesystem.write(path.join(dir, "index.html"), "<html>embedded ui</html>")
  await Filesystem.write(path.join(dir, "app.js"), "console.log('app')")
  return { "index.html": path.join(dir, "index.html"), "assets/app.js": path.join(dir, "app.js") }
}

describe("embedded session UI", () => {
  test("when injected, frontend routes fall back to the embedded index.html and assets are served by key", async () => {
    Server.configureEmbeddedAppDist(await files())
    const app = Server.App()
    const page = await app.request("/some/route")
    expect(page.status).toBe(200)
    expect(await page.text()).toBe("<html>embedded ui</html>")
    const asset = await app.request("/assets/app.js")
    expect(await asset.text()).toBe("console.log('app')")
  })

  test("without injection (standard SDK) there is no embedded UI and no lookup in the repo layout", async () => {
    // The engine must not search upward for apps/desktop/renderer/dist: create it and check the engine ignores it.
    const appsDir = path.resolve(import.meta.dirname, "../../../../apps")
    // The SDK repository root has no apps/; if one exists (not created by this test), leave it alone.
    const created = !existsSync(appsDir)
    if (created) await Filesystem.write(path.join(appsDir, "desktop/renderer/dist/index.html"), "<html>product</html>")
    const previous = process.env.MERAKCODE_APP_DIST
    delete process.env.MERAKCODE_APP_DIST
    try {
      Server.configureEmbeddedAppDist(undefined)
      expect(await Server.appDist()).toBeUndefined()
    } finally {
      if (previous !== undefined) process.env.MERAKCODE_APP_DIST = previous
      if (created) await fs.rm(appsDir, { recursive: true, force: true })
    }
  })
})
