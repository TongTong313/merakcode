import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Workspace } from "@merakcode/engine/infra/project/workspace"
import { tmpdir } from "../fixture/fixture"

describe("Workspace.resolvePath", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("absolute path resolves to its containing folder", async () => {
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
        const target = path.join(b.path, "src", "x.ts")
        const resolved = Workspace.resolvePath(Instance.workspace, target)
        expect("error" in resolved).toBe(false)
        if ("error" in resolved) return
        expect(resolved.folder.name).toBe("beta")
        expect(path.resolve(resolved.filepath)).toBe(path.resolve(target))
      },
    })
  })

  test("relative path defaults to the primary root", async () => {
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
        const resolved = Workspace.resolvePath(Instance.workspace, "src/x.ts")
        expect("error" in resolved).toBe(false)
        if ("error" in resolved) return
        expect(resolved.folder.name).toBe("alpha")
        expect(resolved.filepath).toBe(path.resolve(a.path, "src/x.ts"))
      },
    })
  })

  test("relative path can be scoped by root name", async () => {
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
        const resolved = Workspace.resolvePath(Instance.workspace, "src/x.ts", { root: "beta" })
        expect("error" in resolved).toBe(false)
        if ("error" in resolved) return
        expect(resolved.folder.name).toBe("beta")
        expect(resolved.filepath).toBe(path.resolve(b.path, "src/x.ts"))
      },
    })
  })

  test("absolute path outside the workspace throws", async () => {
    await using a = await tmpdir({ git: true })
    await Instance.provide({
      directory: a.path,
      fn: () => {
        const resolved = Workspace.resolvePath(Instance.workspace, "/etc/passwd")
        expect("error" in resolved).toBe(true)
      },
    })
  })
})

describe("Workspace.searchRoots", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("multi-root without path returns all folder paths", async () => {
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
        const roots = Workspace.searchRoots(Instance.workspace, undefined)
        expect(roots).toHaveLength(2)
      },
    })
  })

  test("with a path, returns only the resolved root", async () => {
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
        const roots = Workspace.searchRoots(Instance.workspace, b.path)
        expect(roots).toHaveLength(1)
        expect(path.resolve(roots[0])).toBe(path.resolve(b.path))
      },
    })
  })
})

describe("Workspace.resolveListPath", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("multi-root empty path returns undefined and name/rest resolves to that root", async () => {
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
        expect(Workspace.resolveListPath(Instance.workspace)).toBeUndefined()
        expect(Workspace.resolveListPath(Instance.workspace, "beta")).toBe(b.path)
        expect(path.resolve(Workspace.resolveListPath(Instance.workspace, "beta/src")!)).toBe(
          path.resolve(b.path, "src"),
        )
      },
    })
  })
})
