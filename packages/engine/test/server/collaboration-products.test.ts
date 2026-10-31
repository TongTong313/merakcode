import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Server } from "@merakcode/engine/app/server/server"
import { Config } from "@merakcode/engine/app/config/files/config"
import { tmpdir } from "../fixture/fixture"
import { configureConnections } from "../fixture/agent-connections"

type Product = {
  id: string
  title: string
  connected: boolean
  enabled?: boolean
  reason?: string
  builtin?: boolean
  source?: string
  version?: string
  path?: string
  command?: string
  args?: string[]
}

/** A command on disk, like an npm shim: it runs node with script and passes the arguments on */
async function shim(dir: string, name: string, script: string) {
  const js = path.join(dir, `${name}.mjs`)
  await fs.writeFile(js, script)
  const command = process.platform === "win32" ? path.join(dir, `${name}.cmd`) : path.join(dir, name)
  await fs.writeFile(
    command,
    process.platform === "win32"
      ? `@node "%~dp0${name}.mjs" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`,
    { mode: 0o755 },
  )
  return command
}

/** The product list, with codex standing in for an installed CLI that runs script when called */
async function products(script: string) {
  await using tmp = await tmpdir()
  const command = await shim(tmp.path, "codex", script)
  await configureConnections({ codex: { command } })
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const response = await Server.App().request(`/agent-connection/product?directory=${encodeURIComponent(tmp.path)}`)
      const list = (await response.json()) as Product[]
      return list.find((item) => item.id === "codex")!
    },
  })
}

test("a product whose command is there but does not run is not connected, and says why", async () => {
  const broken = await products(`process.stderr.write("spawn codex.exe ENOENT"); process.exit(1)`)
  expect(broken.connected).toBe(false)
  expect(broken.reason).toContain("spawn codex.exe ENOENT")
})

test("a product that hangs on --version is not connected after five seconds", async () => {
  const started = Date.now()
  const stuck = await products(`setTimeout(() => {}, 60_000)`)
  expect(stuck.connected).toBe(false)
  expect(stuck.reason).toContain("5")
  expect(Date.now() - started).toBeLessThan(15_000)
}, 30_000)

test("a product that answers --version is connected", async () => {
  expect(await products(`process.stdout.write("codex-cli 0.9.0")`)).toMatchObject({ connected: true })
})

test("a member cannot be added with a product that does not run, and the refusal says why", async () => {
  await using tmp = await tmpdir()
  const js = path.join(tmp.path, "codex.mjs")
  await fs.writeFile(js, `process.stderr.write("spawn codex.exe ENOENT"); process.exit(1)`)
  const command = process.platform === "win32" ? path.join(tmp.path, "codex.cmd") : path.join(tmp.path, "codex")
  await fs.writeFile(
    command,
    process.platform === "win32"
      ? `@node "%~dp0codex.mjs" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`,
    { mode: 0o755 },
  )
  await configureConnections({ codex: { command } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const response = await Server.App().request(`/collaboration?directory=${encodeURIComponent(tmp.path)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leader: { name: "小主" }, seats: [{ name: "abc", product: "codex" }] }),
      })
      expect(response.status).toBe(400)
      expect(((await response.json()) as { message: string }).message).toContain("spawn codex.exe ENOENT")
    },
  })
})

test("the product list does not run every CLI again each time it is opened", async () => {
  await using tmp = await tmpdir()
  const js = path.join(tmp.path, "codex.mjs")
  const runs = path.join(tmp.path, "runs.txt")
  await fs.writeFile(js, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(runs)}, "x")`)
  const command = process.platform === "win32" ? path.join(tmp.path, "codex.cmd") : path.join(tmp.path, "codex")
  await fs.writeFile(
    command,
    process.platform === "win32"
      ? `@node "%~dp0codex.mjs" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`,
    { mode: 0o755 },
  )
  await configureConnections({ codex: { command } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const list = () => Server.App().request(`/agent-connection/product?directory=${encodeURIComponent(tmp.path)}`)
      await list()
      await list()
      expect(await fs.readFile(runs, "utf8")).toBe("x")
    },
  })
})

test("a custom product is only looked for, never run, since it may not know --version", async () => {
  await using tmp = await tmpdir()
  const ran = path.join(tmp.path, "ran.txt")
  // An agent that starts working whatever it is called with
  const command = await shim(
    tmp.path,
    "agent",
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(ran)}, "ran")`,
  )
  await configureConnections({ mine: { command } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const response = await Server.App().request(`/agent-connection/product?directory=${encodeURIComponent(tmp.path)}`)
      const list = (await response.json()) as Product[]
      expect(list.find((item) => item.id === "mine")).toMatchObject({ connected: true })
    },
  })
  await expect(fs.access(ran)).rejects.toThrow()
})

/** The product list and a group-create call against a project whose config is products */
async function withProducts<T>(
  products: Record<string, Config.AgentConnectionProduct>,
  fn: (api: { list: () => Promise<Product[]>; create: (seats: unknown[]) => Promise<Response> }) => Promise<T>,
) {
  await using tmp = await tmpdir()
  await configureConnections(products)
  const query = `directory=${encodeURIComponent(tmp.path)}`
  return await Instance.provide({
    directory: tmp.path,
    fn: () => {
      const app = Server.App()
      return fn({
        list: async () => (await (await app.request(`/agent-connection/product?${query}`)).json()) as Product[],
        create: (seats) =>
          Promise.resolve(
            app.request(`/collaboration?${query}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ leader: { name: "小主" }, seats }),
            }),
          ),
      })
    },
  })
}

test("a built-in product can be turned off with just enabled: false, keeping the rest of its definition", async () => {
  await withProducts({ opencode: { enabled: false } }, async ({ list }) => {
    expect((await list()).find((item) => item.id === "opencode")).toMatchObject({ title: "OpenCode", enabled: false })
  })
})

test("a product that is turned off cannot take a new member, even though its command runs", async () => {
  await withProducts({ mine: { command: process.execPath, enabled: false } }, async ({ list, create }) => {
    expect((await list()).find((item) => item.id === "mine")).toMatchObject({ enabled: false })
    const response = await create([{ name: "小红", product: "mine" }])
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toContain("mine")
  })
})

test("each product says where its definition comes from, and a running CLI its version and path", async () => {
  const codex = await products(`process.stdout.write("codex-cli 0.9.0\\n")`)
  expect(codex).toMatchObject({ builtin: true, source: "global", version: "codex-cli 0.9.0" })
  expect(codex.path).toMatch(/codex(\.cmd)?$/)
  await withProducts({ mine: { command: process.execPath } }, async ({ list }) => {
    const all = await list()
    expect(all.find((item) => item.id === "mine")).toMatchObject({
      builtin: false,
      source: "global",
      path: process.execPath,
    })
    expect(all.find((item) => item.id === "merak")).toMatchObject({ builtin: true, source: "builtin" })
  })
})

test("refresh checks every CLI again instead of using the last result", async () => {
  await using tmp = await tmpdir()
  const runs = path.join(tmp.path, "runs.txt")
  const command = await shim(
    tmp.path,
    "codex",
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(runs)}, "x")`,
  )
  await configureConnections({ codex: { command } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const list = (refresh: boolean) =>
        Server.App().request(
          `/agent-connection/product?directory=${encodeURIComponent(tmp.path)}${refresh ? "&refresh=true" : ""}`,
        )
      await list(false)
      await list(true)
      expect(await fs.readFile(runs, "utf8")).toBe("xx")
    },
  })
})

test("each product carries its definition, for the settings form", async () => {
  const mine = {
    command: "mine",
    args: ["run"],
    resumeArgs: ["run", "{id}"],
    sessionLine: "id=(\w+)",
  }
  await withProducts({ mine }, async ({ list }) => {
    const all = await list()
    expect(all.find((item) => item.id === "mine")).toMatchObject(mine)
    // A built-in adapter drives the CLI; args are only what the user adds
    expect(all.find((item) => item.id === "claude")).toMatchObject({ command: "claude", args: [] })
  })
})

test("a product driven by an adapter shows what the adapter reports, and checking it starts no task", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "ran")
  const fixture = path.join(import.meta.dirname, "..", "collaboration", "fixture", "adapter.ts")
  const scenario = JSON.stringify({ marker })
  await withProducts(
    { mine: { adapter: "member", command: process.execPath, args: [...process.execArgv, fixture, scenario] } },
    async ({ list }) => {
      expect((await list()).find((item) => item.id === "mine")).toMatchObject({ connected: true, version: "1.0.0" })
    },
  )
  await expect(fs.access(marker + ".pid")).rejects.toThrow()
}, 60_000)

test("an adapter that reports its CLI as unavailable makes the product unavailable, with its reason", async () => {
  const fixture = path.join(import.meta.dirname, "..", "collaboration", "fixture", "adapter.ts")
  const scenario = JSON.stringify({ unavailable: "mycli is not installed" })
  await withProducts(
    { mine: { adapter: "member", command: process.execPath, args: [...process.execArgv, fixture, scenario] } },
    async ({ list }) => {
      expect((await list()).find((item) => item.id === "mine")).toMatchObject({
        connected: false,
        reason: "mycli is not installed",
      })
    },
  )
}, 60_000)

test("a CLI older than the recommended version is flagged with how to upgrade, and can still take members", async () => {
  const fixture = path.join(import.meta.dirname, "..", "collaboration", "fixture", "adapter.ts")
  const old = JSON.stringify({ version: "codex-cli 0.77.0", recommended: "0.164.0", upgrade: "codex update" })
  const current = JSON.stringify({ version: "codex-cli 0.164.2", recommended: "0.164.0", upgrade: "codex update" })
  const entry = (scenario: string) => ({
    adapter: "member" as const,
    command: process.execPath,
    args: [...process.execArgv, fixture, scenario],
  })
  await withProducts({ old: entry(old), current: entry(current) }, async ({ list }) => {
    const all = await list()
    expect(all.find((item) => item.id === "old")).toMatchObject({
      connected: true,
      outdated: true,
      recommended: "0.164.0",
      upgrade: "codex update",
    })
    expect(all.find((item) => item.id === "current")).toMatchObject({ connected: true, outdated: false })
  })
}, 60_000)

test("an adapter that cannot start says so, with its own last error", async () => {
  await using tmp = await tmpdir()
  const missing = path.join(tmp.path, "no-such-adapter.mjs")
  await withProducts({ mine: { adapter: "member", command: process.execPath, args: [missing] } }, async ({ list }) => {
    const mine = (await list()).find((item) => item.id === "mine")!
    expect(mine.connected).toBe(false)
    expect(mine.reason).toContain("适配器在响应前退出")
    expect(mine.reason).toContain("no-such-adapter.mjs")
  })
}, 60_000)
