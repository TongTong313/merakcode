import { expect, test } from "vitest"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { runtime, tmpdir } from "../fixture/fixture"
import { Instance } from "@merakcode/engine/infra/project/instance"

test("a nested provide reinitializes the project after its ambient instance was disposed", async () => {
  await using tmp = await tmpdir({ git: true })
  let initializations = 0
  const init = async () => {
    initializations++
  }
  await Instance.provide({
    directory: tmp.path,
    init,
    fn: async () => {
      await Instance.dispose()
      await Instance.provide({
        directory: tmp.path,
        init,
        fn: async () => {
          expect(initializations).toBe(2)
          await Instance.dispose()
        },
      })
    },
  })
})

test("a plugin can await its authenticated client while the project is still bootstrapping", async () => {
  await using tmp = await tmpdir({ git: true })
  const plugin = path.join(tmp.path, "plugin.mjs")
  await Filesystem.write(
    plugin,
    `export default async ({ client }) => {
    const result = await client.session.list({}, { throwOnError: true })
    if (!Array.isArray(result.data)) throw new Error("Missing session list")
    return {}
  }`,
  )
  await Filesystem.write(
    path.join(tmp.path, "merakcode.json"),
    JSON.stringify({ plugin: [pathToFileURL(plugin).href] }),
  )
  const script = path.join(tmp.path, "bootstrap.mts")
  const server = pathToFileURL(path.resolve(import.meta.dirname, "../../src/app/server/server.ts")).href
  await Filesystem.write(
    script,
    `const { Server } = await import(${JSON.stringify(server)})
const response = await Server.App().request("http://localhost/session", { headers: {
  "x-merakcode-directory": encodeURIComponent(${JSON.stringify(tmp.path)}),
  authorization: "Basic " + btoa("merakcode:bootstrap-password"),
} })
if (response.status !== 200) throw new Error(await response.text())
console.log("bootstrap-complete")
process.exit(0)
`,
  )
  const result = await Process.run([...runtime, script], {
    cwd: tmp.path,
    env: { ...process.env, MERAKCODE_SERVER_PASSWORD: "bootstrap-password" },
    signal: AbortSignal.timeout(15_000),
    nothrow: true,
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.text()).toContain("bootstrap-complete")
}, 25_000)
