import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Workspace } from "@merakcode/engine/infra/project/workspace"
import { tmpdir } from "../fixture/fixture"

/**
 * As in VS Code, absolute paths are authoritative and the display layer shows `folderName/rel`. Resolution must accept
 * displayed values back (displayPath and resolveToolPath are inverses); otherwise `beta/foo.ts` passed back by the
 * model or UI would resolve to a wrong path under the primary root.
 */
describe("Workspace folder name prefix resolution", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  const multi = async <T>(fn: (a: string, b: string) => T) => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    return await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: () => fn(a.path, b.path),
    })
  }

  test("displayPath and resolveToolPath round-trip (second root)", async () => {
    await multi((_a, b) => {
      const target = path.resolve(b, "src", "foo.ts")
      const shown = Workspace.displayPath(Instance.workspace, target)
      expect(shown.replace(/\\/g, "/")).toBe("beta/src/foo.ts")
      expect(path.resolve(Workspace.resolveToolPath(Instance.workspace, shown).filepath)).toBe(target)
    })
  })

  test("displayPath and resolveToolPath round-trip (primary root)", async () => {
    await multi((a) => {
      const target = path.resolve(a, "src", "bar.ts")
      const shown = Workspace.displayPath(Instance.workspace, target)
      expect(shown.replace(/\\/g, "/")).toBe("alpha/src/bar.ts")
      expect(path.resolve(Workspace.resolveToolPath(Instance.workspace, shown).filepath)).toBe(target)
    })
  })

  test("a bare folder name resolves to that root", async () => {
    await multi((_a, b) => {
      expect(path.resolve(Workspace.resolveToolPath(Instance.workspace, "beta").filepath)).toBe(path.resolve(b))
    })
  })

  test("resolves relative to primary when the first segment matches no folder name", async () => {
    await multi((a) => {
      expect(path.resolve(Workspace.resolveToolPath(Instance.workspace, "src/foo.ts").filepath)).toBe(
        path.resolve(a, "src/foo.ts"),
      )
    })
  })

  test("folder name prefix has no effect in single-root", async () => {
    await using tmp = await tmpdir({ git: true })
    const name = path.basename(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        // Single-root displayPath has no prefix, so `<name>/x.ts` is a plain relative path
        expect(path.resolve(Workspace.resolveToolPath(Instance.workspace, `${name}/x.ts`).filepath)).toBe(
          path.resolve(tmp.path, name, "x.ts"),
        )
      },
    })
  })

  test("duplicate folder names disable prefix resolution to avoid ambiguity", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "dup", path: a.path },
          { name: "dup", path: b.path },
        ],
      },
      fn: () => {
        expect(path.resolve(Workspace.resolveToolPath(Instance.workspace, "dup/x.ts").filepath)).toBe(
          path.resolve(a.path, "dup/x.ts"),
        )
      },
    })
  })

  test("explicit root takes precedence over the name prefix", async () => {
    await multi((_a, b) => {
      const resolved = Workspace.resolveToolPath(Instance.workspace, "x.ts", { root: "beta" })
      expect(path.resolve(resolved.filepath)).toBe(path.resolve(b, "x.ts"))
    })
  })

  // The grep/glob path argument can also receive `folderName/rel` from the display layer or index
  test("searchRoots honors the folder name prefix", async () => {
    await multi((_a, b) => {
      expect(Workspace.searchRoots(Instance.workspace, "beta").map((r) => path.resolve(r))).toEqual([path.resolve(b)])
      expect(Workspace.searchRoots(Instance.workspace, "beta/src").map((r) => path.resolve(r))).toEqual([
        path.resolve(b, "src"),
      ])
    })
  })

  test("searchRoots resolves relative to primary when the first segment does not match", async () => {
    await multi((a) => {
      expect(Workspace.searchRoots(Instance.workspace, "src").map((r) => path.resolve(r))).toEqual([
        path.resolve(a, "src"),
      ])
    })
  })
})
