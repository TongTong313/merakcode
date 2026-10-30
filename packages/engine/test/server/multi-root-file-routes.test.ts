import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Server } from "@merakcode/engine/app/server/server"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

Log.init({ print: false })

/**
 * In a multi-root workspace the UI may write and delete files in the second folder: the boundary is
 * Instance.containsPath, which covers every root, not "relative to the primary root without a leading ..".
 */
describe("file routes in a multi-root workspace", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  const setup = async () => {
    const a = await tmpdir({ git: true })
    const b = await tmpdir({ git: true })
    const app = Server.App()
    const folders = [
      { name: "alpha", path: a.path },
      { name: "beta", path: b.path },
    ]
    const headers = {
      "Content-Type": "application/json",
      "x-merakcode-workspace-folders": encodeURIComponent(JSON.stringify(folders)),
    }
    const url = (suffix: string) =>
      `http://localhost${suffix}${suffix.includes("?") ? "&" : "?"}directory=${encodeURIComponent(a.path)}`
    return { a, b, app, headers, url }
  }

  test("writes a file in the second root", async () => {
    const { a, b, app, headers, url } = await setup()
    try {
      const target = path.join(b.path, "written.txt")
      const res = await app.request(url("/file/content"), {
        method: "PUT",
        headers,
        body: JSON.stringify({ path: target, content: "beta content" }),
      })
      expect(res.status).toBe(200)
      expect(await Filesystem.readText(target)).toBe("beta content")
    } finally {
      await a[Symbol.asyncDispose]()
      await b[Symbol.asyncDispose]()
    }
  })

  test("deletes a file in the second root", async () => {
    const { a, b, app, headers, url } = await setup()
    try {
      const file = path.join(b.path, "nested", "created.txt")
      await Filesystem.write(file, "x")
      const deleteRes = await app.request(url("/file"), {
        method: "DELETE",
        headers,
        body: JSON.stringify({ path: file }),
      })
      expect(deleteRes.status).toBe(200)
      expect(await Filesystem.isFile(file)).toBe(false)
    } finally {
      await a[Symbol.asyncDispose]()
      await b[Symbol.asyncDispose]()
    }
  })

  test("writes to the second root through a folderName/relative path", async () => {
    const { a, b, app, headers, url } = await setup()
    try {
      const res = await app.request(url("/file/content"), {
        method: "PUT",
        headers,
        body: JSON.stringify({ path: "beta/prefixed.txt", content: "via prefix" }),
      })
      expect(res.status).toBe(200)
      expect(await Filesystem.readText(path.join(b.path, "prefixed.txt"))).toBe("via prefix")
    } finally {
      await a[Symbol.asyncDispose]()
      await b[Symbol.asyncDispose]()
    }
  })

  test("still rejects paths outside the workspace", async () => {
    const { a, b, app, headers, url } = await setup()
    try {
      // A unique name so a file left over from an earlier run can't break the existence check
      const outside = path.resolve(a.path, "..", `outside-workspace-${crypto.randomUUID()}.txt`)
      const res = await app.request(url("/file/content"), {
        method: "PUT",
        headers,
        body: JSON.stringify({ path: outside, content: "nope" }),
      })
      expect(res.status).toBe(400)
      expect(await Filesystem.isFile(outside)).toBe(false)
    } finally {
      await a[Symbol.asyncDispose]()
      await b[Symbol.asyncDispose]()
    }
  })

  test("single-root writes with a relative path still work", async () => {
    await using tmp = await tmpdir()
    const app = Server.App()
    const res = await app.request(`http://localhost/file/content?directory=${encodeURIComponent(tmp.path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "single.txt", content: "ok" }),
    })
    expect(res.status).toBe(200)
    expect(await Filesystem.readText(path.join(tmp.path, "single.txt"))).toBe("ok")
  })
})
