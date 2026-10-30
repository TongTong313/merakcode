import { test, expect, describe } from "vitest"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "@merakcode/util/filesystem"
import { File } from "@merakcode/engine/agent/workspace/file/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Global } from "@merakcode/engine/infra/global/index"
import { tmpdir } from "../fixture/fixture"

describe("Filesystem.contains", () => {
  test("allows paths within project", () => {
    expect(Filesystem.contains("/project", "/project/src")).toBe(true)
    expect(Filesystem.contains("/project", "/project/src/file.ts")).toBe(true)
    expect(Filesystem.contains("/project", "/project")).toBe(true)
  })

  test("blocks ../ traversal", () => {
    expect(Filesystem.contains("/project", "/project/../etc")).toBe(false)
    expect(Filesystem.contains("/project", "/project/src/../../etc")).toBe(false)
    expect(Filesystem.contains("/project", "/etc/passwd")).toBe(false)
  })

  test("blocks absolute paths outside project", () => {
    expect(Filesystem.contains("/project", "/etc/passwd")).toBe(false)
    expect(Filesystem.contains("/project", "/tmp/file")).toBe(false)
    expect(Filesystem.contains("/home/user/project", "/home/user/other")).toBe(false)
  })

  test("handles prefix collision edge cases", () => {
    expect(Filesystem.contains("/project", "/project-other/file")).toBe(false)
    expect(Filesystem.contains("/project", "/projectfile")).toBe(false)
  })
})

/*
 * File.read and File.list accept paths outside the workspace so agent changes there can be previewed. containsPath
 * is still used elsewhere; these tests check that outside paths are readable and inside paths still work.
 */
describe("File.read outside workspace", () => {
  test("reads absolute path outside project directory", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "outside.txt"), "outside content")
      },
    })
    const outsideFile = path.join(outside.path, "outside.txt")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.read(outsideFile)
        expect(result.type).toBe("text")
        expect(result.content).toBe("outside content")
      },
    })
  })

  test("allows valid paths within project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "valid.txt"), "valid content")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.read("valid.txt")
        expect(result.content).toBe("valid content")
      },
    })
  })

  test("reads global plan file by absolute path", async () => {
    await using tmp = await tmpdir()
    const planName = "1234567890-test-plan.md"
    const planPath = path.join(Global.Path.data, "plans", planName)
    const planBody = "## Scope\n\ntest plan content"

    await fs.mkdir(path.dirname(planPath), { recursive: true })
    await Filesystem.write(planPath, planBody)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.read(planPath)
          expect(result.type).toBe("text")
          expect(result.content).toBe(planBody)
        },
      })
    } finally {
      await fs.unlink(planPath).catch(() => undefined)
    }
  })

  test("reads global plan file when path uses forward slashes", async () => {
    await using tmp = await tmpdir()
    const planName = "1234567891-test-plan.md"
    const planPath = path.join(Global.Path.data, "plans", planName)
    const planBody = "## Scope\n\nforward slash path"

    await fs.mkdir(path.dirname(planPath), { recursive: true })
    await Filesystem.write(planPath, planBody)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const forwardSlashPath = planPath.replace(/\\/g, "/")
          const result = await File.read(forwardSlashPath)
          expect(result.type).toBe("text")
          expect(result.content).toBe(planBody)
        },
      })
    } finally {
      await fs.unlink(planPath).catch(() => undefined)
    }
  })
})

describe("File.list outside workspace", () => {
  test("lists absolute directory outside project", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "a.txt"), "a")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.list(outside.path)
        expect(Array.isArray(result)).toBe(true)
        expect(result.some((n) => n.name === "a.txt")).toBe(true)
      },
    })
  })

  test("allows valid subdirectory listing", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "subdir", "file.txt"), "content")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.list("subdir")
        expect(Array.isArray(result)).toBe(true)
      },
    })
  })
})

describe("Instance.containsPath", () => {
  test("returns true for path inside directory", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.containsPath(path.join(tmp.path, "foo.txt"))).toBe(true)
        expect(Instance.containsPath(path.join(tmp.path, "src", "file.ts"))).toBe(true)
      },
    })
  })

  test("returns true for path inside worktree but outside directory (monorepo subdirectory scenario)", async () => {
    await using tmp = await tmpdir({ git: true })
    const subdir = path.join(tmp.path, "packages", "lib")
    await fs.mkdir(subdir, { recursive: true })

    await Instance.provide({
      directory: subdir,
      fn: () => {
        // .merakcode at worktree root, but we're running from packages/lib
        expect(Instance.containsPath(path.join(tmp.path, ".merakcode", "state"))).toBe(true)
        // sibling package should also be accessible
        expect(Instance.containsPath(path.join(tmp.path, "packages", "other", "file.ts"))).toBe(true)
        // worktree root itself
        expect(Instance.containsPath(tmp.path)).toBe(true)
      },
    })
  })

  test("returns false for path outside both directory and worktree", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
        expect(Instance.containsPath("/tmp/other-project")).toBe(false)
      },
    })
  })

  test("returns false for path with .. escaping worktree", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.containsPath(path.join(tmp.path, "..", "escape.txt"))).toBe(false)
      },
    })
  })

  test("handles directory === worktree (running from repo root)", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.directory).toBe(Instance.worktree)
        expect(Instance.containsPath(path.join(tmp.path, "file.txt"))).toBe(true)
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
      },
    })
  })

  test("non-git project does not allow arbitrary paths via worktree='/'", async () => {
    await using tmp = await tmpdir() // no git: true

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        // worktree is "/" for non-git projects, but containsPath should NOT allow all paths
        expect(Instance.containsPath(path.join(tmp.path, "file.txt"))).toBe(true)
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
        expect(Instance.containsPath("/tmp/other")).toBe(false)
      },
    })
  })

  test("multi-root: second folder paths are inside workspace boundary", async () => {
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
        expect(Instance.containsPath(path.join(b.path, "src", "file.ts"))).toBe(true)
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
      },
    })
  })
})
