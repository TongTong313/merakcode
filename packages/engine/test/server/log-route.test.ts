import { expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { runtime } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

test("log ingestion enforces authentication, component validation and payload bounds", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "merakcode-log-api-"))
  try {
    const script = path.join(root, "api.mts")
    const source = pathToFileURL(path.join(import.meta.dirname, "../../src/server/server.ts")).href
    await Filesystem.write(
      script,
      `const { Server } = await import(${JSON.stringify(source)})
const app = Server.App()
const body = { component: "web", service: "renderer", level: "error", message: "window.error" }
const request = (data: unknown, authorized = true) => app.request("http://localhost/log", {
  method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON.stringify(data))), ...(authorized ? { authorization: "Basic " + btoa("merakcode:test-password") } : {}) }, body: JSON.stringify(data),
})
const statuses = []
statuses.push((await request(body, false)).status)
statuses.push((await request(body)).status)
statuses.push((await request({ ...body, component: "../../escape" })).status)
statuses.push((await request({ ...body, message: "x".repeat(8193) })).status)
statuses.push((await request({ ...body, extra: { value: "x".repeat(65536) } })).status)
console.log(JSON.stringify(statuses))
process.exit(0)
`,
    )
    const child = Process.spawn([...runtime, script], {
      env: {
        ...process.env,
        MERAKCODE_SERVER_PASSWORD: "test-password",
        MERAKCODE_SERVER_USERNAME: "merakcode",
        MERAKCODE_LOG_ROOT: path.join(root, "logs"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout.trim())).toEqual([401, 200, 400, 400, 413])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30000)
