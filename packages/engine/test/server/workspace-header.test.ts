import { afterEach, describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Server } from "@merakcode/engine/app/server/server"
import { Log } from "@merakcode/log/logger"
import { Filesystem } from "@merakcode/util/filesystem"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("x-merakcode-workspace-folders header", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("without the header path.get returns a single-root workspace", async () => {
    await using tmp = await tmpdir()
    const app = Server.App()
    // Windows user names may contain non-ASCII characters, so the directory must be encoded (as the SDK does)
    const res = await app.request(`http://localhost/path?directory=${encodeURIComponent(tmp.path)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      directory: string
      workspace?: { primary: string; folders: Array<{ path: string }> }
    }
    expect(Filesystem.sameDirectory(body.directory, tmp.path)).toBe(true)
    expect(body.workspace?.folders).toHaveLength(1)
    expect(Filesystem.sameDirectory(body.workspace!.folders[0].path, tmp.path)).toBe(true)
  })

  test("with the folders header path.get returns every root", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    const app = Server.App()
    const folders = [
      { name: "alpha", path: a.path },
      { name: "beta", path: b.path },
    ]
    const res = await app.request(`http://localhost/path?directory=${encodeURIComponent(a.path)}`, {
      headers: {
        "x-merakcode-workspace-folders": encodeURIComponent(JSON.stringify(folders)),
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      workspace?: { primary: string; folders: Array<{ name: string; path: string }> }
    }
    expect(body.workspace?.folders).toHaveLength(2)
    expect(body.workspace?.folders.map((f) => f.name)).toEqual(["alpha", "beta"])
  })

  test("multiple roots without a workspace file get a fingerprint id from path.get", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    const app = Server.App()
    const folders = [
      { name: "alpha", path: a.path },
      { name: "beta", path: b.path },
    ]
    const res = await app.request(`http://localhost/path?directory=${encodeURIComponent(a.path)}`, {
      headers: { "x-merakcode-workspace-folders": encodeURIComponent(JSON.stringify(folders)) },
    })
    const body = (await res.json()) as { workspace?: { id?: string } }
    expect(body.workspace?.id).toMatch(/^ws_[0-9a-f]{16}$/)
  })

  test("without the header (CLI contract) there is no workspace id", async () => {
    await using tmp = await tmpdir()
    const app = Server.App()
    const res = await app.request(`http://localhost/path?directory=${encodeURIComponent(tmp.path)}`)
    const body = (await res.json()) as { workspace?: { id?: string } }
    expect(body.workspace?.id).toBeUndefined()
  })

  test("an invalid folders header falls back to a single root", async () => {
    await using tmp = await tmpdir()
    const app = Server.App()
    const res = await app.request(`http://localhost/path?directory=${encodeURIComponent(tmp.path)}`, {
      headers: {
        "x-merakcode-workspace-folders": "not-json",
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      workspace?: { folders: Array<{ path: string }> }
    }
    expect(body.workspace?.folders).toHaveLength(1)
  })
})
