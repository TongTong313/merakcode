import { describe, expect, test } from "vitest"
import { Workspace } from "@merakcode/engine/project/workspace"

/**
 * Workspace identity, like the bucket key of VS Code workspaceStorage:
 * - Saved workspace: the .code-workspace file; adding or removing folders keeps the identity.
 * - Untitled workspace: a fingerprint of the sorted folders. VS Code uses an untitled URI that is forgotten on close;
 *   a fingerprint lets reopening or saving find it again (see microsoft/vscode#301793).
 * - Single root (including CLI/TUI): no workspace identity; the regular project path is used.
 */
describe("Workspace.identity", () => {
  test("single root has no workspace identity", () => {
    expect(Workspace.identity({ directory: "D:/code/alpha" })).toBeUndefined()
    expect(Workspace.identity({ directory: "D:/code/alpha", folders: [{ path: "D:/code/alpha" }] })).toBeUndefined()
  })

  test("multi-root without a workspace file uses the folder fingerprint", () => {
    const id = Workspace.identity({
      directory: "D:/code/alpha",
      folders: [{ path: "D:/code/alpha" }, { path: "D:/code/beta" }],
    })
    expect(id?.id).toMatch(/^ws_[0-9a-f]{16}$/)
    expect(id?.fingerprint).toBe(Workspace.fingerprint(["D:/code/alpha", "D:/code/beta"]))
  })

  test("folder order does not change the identity", () => {
    const a = Workspace.identity({
      directory: "D:/code/alpha",
      folders: [{ path: "D:/code/alpha" }, { path: "D:/code/beta" }],
    })
    const b = Workspace.identity({
      directory: "D:/code/beta",
      folders: [{ path: "D:/code/beta" }, { path: "D:/code/alpha" }],
    })
    expect(b?.id).toBe(a!.id)
    expect(b?.fingerprint).toBe(a!.fingerprint)
  })

  test("path spelling (slashes, drive letter case, trailing slash) does not affect the identity", () => {
    const a = Workspace.identity({
      directory: "D:/code/alpha",
      folders: [{ path: "D:/code/alpha" }, { path: "D:/code/beta" }],
    })
    const b = Workspace.identity({
      directory: "d:\\code\\alpha",
      folders: [{ path: "d:\\code\\alpha\\" }, { path: "D:\\code\\beta" }],
    })
    expect(b?.id).toBe(a!.id)
  })

  test("fingerprint ignores order and normalizes path spelling", () => {
    expect(Workspace.fingerprint(["D:/b", "D:/a"])).toBe(Workspace.fingerprint(["d:\\a\\", "D:\\b"]))
  })

  test("different folder sets give different fingerprints", () => {
    expect(Workspace.fingerprint(["D:/a", "D:/b"])).not.toBe(Workspace.fingerprint(["D:/a", "D:/c"]))
  })
})
