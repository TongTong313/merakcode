import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Workspace } from "@merakcode/engine/infra/project/workspace"
import { Filesystem } from "@merakcode/util/filesystem"
import { tmpdir } from "../fixture/fixture"

describe("Workspace", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("single-root provide has only the primary folder and a key equal to the directory", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.workspace.primary).toBe(Filesystem.normalize(tmp.path))
        expect(Instance.workspace.folders).toHaveLength(1)
        expect(Instance.workspace.folders[0].path).toBe(Filesystem.normalize(tmp.path))
        expect(Instance.workspace.key).toBe(Filesystem.normalize(tmp.path))
      },
    })
  })

  test("multi-root provide builds folders with a key different from single-root", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: () => {
        expect(Instance.workspace.folders).toHaveLength(2)
        expect(Instance.workspace.folders.map((f) => f.name)).toEqual(["alpha", "beta"])
        expect(Instance.workspace.key).not.toBe(Filesystem.normalize(a.path))
        expect(Instance.workspace.key.startsWith("workspace")).toBe(true)
      },
    })
  })

  test("workspaceKey is stable for the same folders and order-sensitive", () => {
    const a = "/tmp/a"
    const b = "/tmp/b"
    const k1 = Workspace.key(a, [a, b])
    const k2 = Workspace.key(a, [a, b])
    const k3 = Workspace.key(a, [b, a])
    expect(k1).toBe(k2)
    expect(k1).not.toBe(k3)
  })

  test("lspFolders returns name and uri for every root", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: () => {
        const folders = Workspace.lspFolders(Instance.workspace)
        expect(folders).toHaveLength(2)
        expect(folders.map((f) => f.name)).toEqual(["alpha", "beta"])
        expect(folders.every((f) => f.uri.startsWith("file:"))).toBe(true)
      },
    })
  })

  test("parseFoldersHeader parses valid JSON and returns undefined for invalid input", () => {
    const folders = Workspace.parseFoldersHeader(
      encodeURIComponent(JSON.stringify([{ name: "a", path: "/tmp/a" }, { path: "/tmp/b" }])),
    )
    expect(folders).toEqual([
      { name: "a", path: "/tmp/a" },
      { name: undefined, path: "/tmp/b" },
    ])
    expect(Workspace.parseFoldersHeader("not-json")).toBeUndefined()
    expect(Workspace.parseFoldersHeader(undefined)).toBeUndefined()
    expect(Workspace.parseFoldersHeader("[]")).toBeUndefined()
  })
})

describe("Instance.containsPath multi-root", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("containsPath is true for the second root and false outside all roots", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })

    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "a", path: a.path },
          { name: "b", path: b.path },
        ],
      },
      fn: () => {
        expect(Instance.containsPath(path.join(a.path, "foo.txt"))).toBe(true)
        expect(Instance.containsPath(path.join(b.path, "bar.txt"))).toBe(true)
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
        expect(Instance.containsPath(path.join(a.path, "..", "escape.txt"))).toBe(false)
      },
    })
  })
})
