import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir, runtime } from "../../test/fixture/fixture"
import { seedCatalog } from "../../../../script/node/seed-catalog.ts"
import { Process } from "@merakcode/util/process"

test("a real listener serves HTTP and terminal WebSockets and refuses connections after stop", async () => {
  await using root = await tmpdir({ git: true })
  await seedCatalog(root.path)
  const modules = path.join(root.path, "node_modules")
  await fs.mkdir(modules, { recursive: true })
  await fs.symlink(
    path.dirname(fileURLToPath(import.meta.resolve("zod"))),
    path.join(modules, "zod"),
    process.platform === "win32" ? "junction" : "dir",
  )
  const result = await Process.run([...runtime, path.join(import.meta.dirname, "listen-fixture.ts")], {
    cwd: root.path,
    timeout: 60_000,
    nothrow: true,
    env: {
      ...process.env,
      MERAKCODE_HOME: root.path,
      MERAKCODE_TEST_HOME: path.join(root.path, "home"),
      MERAKCODE_TEST_MANAGED_CONFIG_DIR: path.join(root.path, "managed"),
      MERAKCODE_DISABLE_CATALOG_FETCH: "1",
      MERAKCODE_CONFIG: "",
      MERAKCODE_CONFIG_DIR: "",
      MERAKCODE_CONFIG_CONTENT: "",
      MERAKCODE_CLIENT: "",
      MERAKCODE_SERVER_USERNAME: "listen-fixture",
      MERAKCODE_SERVER_PASSWORD: "fixture-password",
    },
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(JSON.parse(result.text().trim().split("\n").at(-1)!)).toEqual({
    port: true,
    url: true,
    hostname: "127.0.0.1",
    sealed: true,
    health: 200,
    created: 200,
    echo: true,
    stopped: true,
  })
}, 90_000)
