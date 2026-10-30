// Memory HTTP routes: anything outside the memory directory must be rejected, since this is the only entry point that
// takes an arbitrary path parameter.
import fs from "fs/promises"
import path from "path"
import { afterEach, describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { MemoryPath } from "@merakcode/engine/agent/memory/path"
import { Server } from "@merakcode/engine/app/server/server"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

const query = (directory: string, target: string) =>
  `?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(target)}`

/** Create a memory entry in the workspace's memory directory and return { root, file } */
async function seed(directory: string, rel: string, body: string) {
  return Instance.provide({
    directory,
    fn: async () => {
      const root = MemoryPath.directory()
      const file = path.join(root, rel)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await Filesystem.write(file, body)
      await Filesystem.write(MemoryPath.entrypoint(), `- [A](${rel}) - hook`)
      return { root, file }
    },
  })
}

const entry = ["---", "name: A", "description: 描述", "type: user", "---", "", "正文"].join("\n")

describe("GET /memory", () => {
  test("returns the memory root, the index text and the entry list", async () => {
    await using tmp = await tmpdir({ git: true })
    const { root } = await seed(tmp.path, "user/a.md", entry)

    const response = await Server.App().request(`/memory?directory=${encodeURIComponent(tmp.path)}`)

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      directory: string
      index: string
      entries: { filename: string; name: string | null; type?: string }[]
    }
    expect(body.directory).toBe(root)
    expect(body.index).toContain("user/a.md")
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({ filename: "user/a.md", name: "A", type: "user" })
  })
})

describe("GET /memory/entry", () => {
  test("returns the entry content", async () => {
    await using tmp = await tmpdir({ git: true })
    const { file } = await seed(tmp.path, "user/a.md", entry)

    const response = await Server.App().request(`/memory/entry${query(tmp.path, file)}`)

    expect(response.status).toBe(200)
    expect(((await response.json()) as { content: string }).content).toContain("正文")
  })

  test("a path outside the memory directory returns 400 without leaking the file", async () => {
    await using tmp = await tmpdir({ git: true })
    await seed(tmp.path, "user/a.md", entry)
    const outside = path.join(tmp.path, "secret.txt")
    await Filesystem.write(outside, "TOP-SECRET")

    const response = await Server.App().request(`/memory/entry${query(tmp.path, outside)}`)

    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain("TOP-SECRET")
  })
})

describe("DELETE /memory/entry", () => {
  test("deletes the file and removes its index line", async () => {
    await using tmp = await tmpdir({ git: true })
    const { root, file } = await seed(tmp.path, "user/a.md", entry)

    const response = await Server.App().request(`/memory/entry${query(tmp.path, file)}`, { method: "DELETE" })

    expect(response.status).toBe(200)
    expect(await Filesystem.isFile(file)).toBe(false)
    expect(await Filesystem.readText(path.join(root, "MEMORY.md"))).not.toContain("user/a.md")
  })

  test("a path outside the memory directory returns 400 and the file is not deleted", async () => {
    await using tmp = await tmpdir({ git: true })
    await seed(tmp.path, "user/a.md", entry)
    const victim = path.join(tmp.path, "victim.txt")
    await Filesystem.write(victim, "别删我")

    const response = await Server.App().request(`/memory/entry${query(tmp.path, victim)}`, { method: "DELETE" })

    expect(response.status).toBe(400)
    expect(await Filesystem.isFile(victim)).toBe(true)
  })
})
