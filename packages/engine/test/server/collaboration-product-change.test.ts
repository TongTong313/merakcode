import { afterEach, beforeEach, expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { parse } from "jsonc-parser"
import { globalConfigFile } from "@merakcode/util/paths"
import { Config } from "@merakcode/engine/config/config"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { tmpdir } from "../fixture/fixture"

type Product = {
  id: string
  title: string
  enabled: boolean
  builtin: boolean
  source: string
  command?: string
  format?: string
  args?: string[]
  resumeArgs?: string[]
  sessionLine?: string
}

const file = globalConfigFile()
let saved: string | undefined

beforeEach(async () => {
  saved = await fs.readFile(file, "utf8").catch(() => undefined)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `{\n  // my own note\n  "locale": "zh-CN"\n}\n`)
  Config.global.reset()
  Config.state.invalidateAll()
})

afterEach(async () => {
  if (saved === undefined) await fs.rm(file, { force: true })
  else await fs.writeFile(file, saved)
  Config.global.reset()
  Config.state.invalidateAll()
})

/** Runs fn in a project whose own config defines products, with calls to change and to list the products */
async function inProject<T>(
  products: Record<string, Config.CollaborationProduct>,
  fn: (change: (body: unknown) => Promise<Response>, list: () => Promise<Product[]>) => Promise<T>,
) {
  await using tmp = await tmpdir({ config: { collaboration: { products } } })
  const url = `/collaboration/product?directory=${encodeURIComponent(tmp.path)}`
  return await Instance.provide({
    directory: tmp.path,
    fn: () => {
      const app = Server.App()
      return fn(
        (body) =>
          Promise.resolve(
            app.request(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          ),
        async () => (await (await app.request(url)).json()) as Product[],
      )
    },
  })
}

const global = async () => parse(await fs.readFile(file, "utf8"))

test("a product added in settings goes into the global config, keeping the rest of the file and its comments", async () => {
  await inProject({}, async (change) => {
    const response = await change({ type: "add", id: "my-agent", product: { command: "my-agent", title: "My Agent" } })
    expect(response.status).toBe(200)
    const list = (await response.json()) as Product[]
    expect(list.find((item) => item.id === "my-agent")).toMatchObject({
      title: "My Agent",
      source: "global",
      builtin: false,
    })
  })
  const text = await fs.readFile(file, "utf8")
  expect(text).toContain("// my own note")
  expect((await global()).locale).toBe("zh-CN")
  expect((await global()).collaboration.products["my-agent"]).toEqual({ command: "my-agent", title: "My Agent" })
})

test("a new product needs an id of its own made of letters, digits, - or _, and is refused otherwise with a reason", async () => {
  await inProject({ mine: { command: "mine" } }, async (change) => {
    for (const id of ["merak", "claude", "mine", "my agent", ""]) {
      const response = await change({ type: "add", id, product: { command: "x" } })
      expect(response.status).toBe(400)
      expect(((await response.json()) as { message: string }).message).toBeTruthy()
    }
  })
  expect((await global()).collaboration).toBeUndefined()
})

/** The fields of a product the settings form sends back */
const form = ({ title, command, format, args, resumeArgs, sessionLine }: Product) => ({
  title,
  command,
  format,
  args,
  resumeArgs,
  sessionLine,
})

test("editing a built-in product writes only what differs from its default, so later defaults still reach the rest", async () => {
  await inProject({}, async (change, list) => {
    const claude = (await list()).find((item) => item.id === "claude")!
    const response = await change({ type: "update", id: "claude", product: { ...form(claude), title: "Claude" } })
    expect(response.status).toBe(200)
    expect(((await response.json()) as Product[]).find((item) => item.id === "claude")).toMatchObject({
      title: "Claude",
      args: claude.args,
      source: "global",
    })
  })
  expect((await global()).collaboration.products).toEqual({ claude: { title: "Claude" } })
})

test("removing a product deletes a custom one and restores a built-in one to its default", async () => {
  await inProject({}, async (change, list) => {
    await change({ type: "add", id: "mine", product: { command: "mine" } })
    await change({ type: "update", id: "claude", product: { title: "Claude" } })
    await change({ type: "remove", id: "mine" })
    const response = await change({ type: "remove", id: "claude" })
    expect(response.status).toBe(200)
    expect((await list()).find((item) => item.id === "mine")).toBeUndefined()
    expect((await list()).find((item) => item.id === "claude")).toMatchObject({
      title: "Claude Code",
      source: "builtin",
    })
  })
  expect((await global()).collaboration?.products ?? {}).toEqual({})
})

test("a product turned off and on again in settings is back to how it was, with nothing left in the config", async () => {
  await inProject({}, async (change, list) => {
    await change({ type: "enabled", id: "codex", enabled: false })
    expect((await list()).find((item) => item.id === "codex")).toMatchObject({ enabled: false })
    expect((await global()).collaboration.products).toEqual({ codex: { enabled: false } })
    await change({ type: "enabled", id: "codex", enabled: true })
    expect((await list()).find((item) => item.id === "codex")).toMatchObject({ enabled: true, source: "builtin" })
  })
  expect((await global()).collaboration?.products ?? {}).toEqual({})
})

test("editing a product that is turned off leaves it off", async () => {
  await inProject({}, async (change, list) => {
    await change({ type: "add", id: "mine", product: { command: "mine" } })
    await change({ type: "enabled", id: "mine", enabled: false })
    await change({ type: "enabled", id: "codex", enabled: false })
    await change({ type: "update", id: "mine", product: { command: "mine", title: "Mine" } })
    await change({ type: "update", id: "codex", product: { title: "Codex CLI" } })
    const all = await list()
    expect(all.find((item) => item.id === "mine")).toMatchObject({ title: "Mine", enabled: false })
    expect(all.find((item) => item.id === "codex")).toMatchObject({ title: "Codex CLI", enabled: false })
  })
})

test("settings cannot change a product from the project's config, MerakCode, or one that does not exist", async () => {
  await inProject({ theirs: { command: "theirs" } }, async (change) => {
    for (const id of ["theirs", "merak", "nope"]) {
      for (const body of [
        { type: "update", id, product: { command: "x" } },
        { type: "remove", id },
        { type: "enabled", id, enabled: false },
      ]) {
        const response = await change(body)
        expect(response.status, `${body.type} ${id}`).toBe(400)
        expect(((await response.json()) as { message: string }).message).toBeTruthy()
      }
    }
  })
  expect((await global()).collaboration).toBeUndefined()
})

test("a product saved from settings needs a command, and a session line that is a regular expression", async () => {
  await inProject({}, async (change) => {
    await change({ type: "add", id: "mine", product: { command: "mine" } })
    for (const body of [
      { type: "add", id: "a", product: { title: "A" } },
      { type: "add", id: "b", product: { command: "  " } },
      { type: "add", id: "c", product: { command: "c", sessionLine: "(" } },
      { type: "update", id: "mine", product: { command: "" } },
      { type: "update", id: "claude", product: { sessionLine: "(" } },
    ]) {
      const response = await change(body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(((await response.json()) as { message: string }).message).toBeTruthy()
    }
  })
  expect((await global()).collaboration.products).toEqual({ mine: { command: "mine" } })
})

test("saving a built-in product unchanged leaves nothing in the config, so it still reads as not modified", async () => {
  await inProject({}, async (change, list) => {
    const claude = (await list()).find((item) => item.id === "claude")!
    await change({ type: "update", id: "claude", product: form(claude) })
    expect((await list()).find((item) => item.id === "claude")).toMatchObject({ source: "builtin" })
  })
  expect((await global()).collaboration?.products ?? {}).toEqual({})
})
