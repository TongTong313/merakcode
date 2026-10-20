import { describe, expect, test, vi } from "vitest"
import type { Project as ProjectNS } from "@merakcode/engine/project/project"
import { Log } from "@merakcode/log/logger"
import { Storage } from "@merakcode/engine/storage/storage"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

Log.init({ print: false })

// vi.mock is hoisted to the top of the file, so the real implementation must be imported explicitly
const { git: originalGit } =
  await vi.importActual<typeof import("@merakcode/engine/util/git")>("@merakcode/engine/util/git")

type Mode = "none" | "rev-list-fail" | "top-fail" | "common-dir-fail"
let mode: Mode = "none"

vi.mock("@merakcode/engine/util/git", () => ({
  git: (args: string[], opts: { cwd: string; env?: Record<string, string> }) => {
    const cmd = ["git", ...args].join(" ")
    if (
      mode === "rev-list-fail" &&
      cmd.includes("git rev-list") &&
      cmd.includes("--max-parents=0") &&
      cmd.includes("--all")
    ) {
      return Promise.resolve({
        exitCode: 128,
        text: () => Promise.resolve(""),
        stdout: Buffer.from(""),
        stderr: Buffer.from("fatal"),
      })
    }
    if (mode === "top-fail" && cmd.includes("git rev-parse") && cmd.includes("--show-toplevel")) {
      return Promise.resolve({
        exitCode: 128,
        text: () => Promise.resolve(""),
        stdout: Buffer.from(""),
        stderr: Buffer.from("fatal"),
      })
    }
    if (mode === "common-dir-fail" && cmd.includes("git rev-parse") && cmd.includes("--git-common-dir")) {
      return Promise.resolve({
        exitCode: 128,
        text: () => Promise.resolve(""),
        stdout: Buffer.from(""),
        stderr: Buffer.from("fatal"),
      })
    }
    return originalGit(args, opts)
  },
}))

async function withMode(next: Mode, run: () => Promise<void>) {
  const prev = mode
  mode = next
  try {
    await run()
  } finally {
    mode = prev
  }
}

async function loadProject() {
  return (await import("@merakcode/engine/project/project")).Project
}

describe("Project.fromDirectory", () => {
  test("should handle git repository with no commits", async () => {
    const p = await loadProject()
    await using tmp = await tmpdir()
    await Process.run(["git", "init"], { cwd: tmp.path })

    const { project } = await p.fromDirectory(tmp.path)

    expect(project).toBeDefined()
    expect(project.id).toBe("global")
    expect(project.vcs).toBe("git")
    expect(project.worktree).toBe(tmp.path)

    const merakCodeFile = path.join(tmp.path, ".git", "merakcode")
    const fileExists = await Filesystem.isFile(merakCodeFile)
    expect(fileExists).toBe(false)
  })

  test("should handle git repository with commits", async () => {
    const p = await loadProject()
    await using tmp = await tmpdir({ git: true })

    const { project } = await p.fromDirectory(tmp.path)

    expect(project).toBeDefined()
    expect(project.id).not.toBe("global")
    expect(project.vcs).toBe("git")
    expect(project.worktree).toBe(tmp.path)

    const merakCodeFile = path.join(tmp.path, ".git", "merakcode")
    const fileExists = await Filesystem.isFile(merakCodeFile)
    expect(fileExists).toBe(true)
  })

  test("keeps git vcs when rev-list exits non-zero with empty output", async () => {
    const p = await loadProject()
    await using tmp = await tmpdir()
    await Process.run(["git", "init"], { cwd: tmp.path })

    await withMode("rev-list-fail", async () => {
      const { project } = await p.fromDirectory(tmp.path)
      expect(project.vcs).toBe("git")
      expect(project.id).toBe("global")
      expect(project.worktree).toBe(tmp.path)
    })
  })

  test("keeps git vcs when show-toplevel exits non-zero with empty output", async () => {
    const p = await loadProject()
    await using tmp = await tmpdir({ git: true })

    await withMode("top-fail", async () => {
      const { project, sandbox } = await p.fromDirectory(tmp.path)
      expect(project.vcs).toBe("git")
      expect(project.worktree).toBe(tmp.path)
      expect(sandbox).toBe(tmp.path)
    })
  })

  test("keeps git vcs when git-common-dir exits non-zero with empty output", async () => {
    const p = await loadProject()
    await using tmp = await tmpdir({ git: true })

    await withMode("common-dir-fail", async () => {
      const { project, sandbox } = await p.fromDirectory(tmp.path)
      expect(project.vcs).toBe("git")
      expect(project.worktree).toBe(tmp.path)
      expect(sandbox).toBe(tmp.path)
    })
  })
})

describe("Project.fromDirectory with worktrees", () => {
  test("should set worktree to root when called from root", async () => {
    const p = await loadProject()
    await using tmp = await tmpdir({ git: true })

    const { project, sandbox } = await p.fromDirectory(tmp.path)

    expect(project.worktree).toBe(tmp.path)
    expect(sandbox).toBe(tmp.path)
    expect(project.sandboxes).not.toContain(tmp.path)
  })

  test("should set worktree to root when called from a worktree", async () => {
    const p = await loadProject()
    await using tmp = await tmpdir({ git: true })

    const worktreePath = path.join(tmp.path, "..", `worktree-test-${crypto.randomUUID()}`)
    await Process.run(["git", "worktree", "add", worktreePath, "-b", "test-branch"], { cwd: tmp.path })

    const { project, sandbox } = await p.fromDirectory(worktreePath)

    expect(project.worktree).toBe(tmp.path)
    expect(sandbox).toBe(worktreePath)
    expect(project.sandboxes).toContain(worktreePath)
    expect(project.sandboxes).not.toContain(tmp.path)

    await Process.run(["git", "worktree", "remove", worktreePath], { cwd: tmp.path })
  })

  test("should accumulate multiple worktrees in sandboxes", async () => {
    const p = await loadProject()
    await using tmp = await tmpdir({ git: true })

    const suffix = crypto.randomUUID()
    const worktree1 = path.join(tmp.path, "..", `worktree-1-${suffix}`)
    const worktree2 = path.join(tmp.path, "..", `worktree-2-${suffix}`)
    await Process.run(["git", "worktree", "add", worktree1, "-b", "branch-1"], { cwd: tmp.path })
    await Process.run(["git", "worktree", "add", worktree2, "-b", "branch-2"], { cwd: tmp.path })

    await p.fromDirectory(worktree1)
    const { project } = await p.fromDirectory(worktree2)

    expect(project.worktree).toBe(tmp.path)
    expect(project.sandboxes).toContain(worktree1)
    expect(project.sandboxes).toContain(worktree2)
    expect(project.sandboxes).not.toContain(tmp.path)

    await Process.run(["git", "worktree", "remove", worktree1], { cwd: tmp.path })
    await Process.run(["git", "worktree", "remove", worktree2], { cwd: tmp.path })
  })
})

describe("Project.discover", () => {
  test("should discover favicon.png in root", async () => {
    const p = await loadProject()
    await using tmp = await tmpdir({ git: true })
    const { project } = await p.fromDirectory(tmp.path)

    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await Filesystem.write(path.join(tmp.path, "favicon.png"), pngData)

    await p.discover(project)

    const updated = await Storage.read<ProjectNS.Info>(["project", project.id])
    expect(updated.icon).toBeDefined()
    expect(updated.icon?.url).toSatisfy((value: string) => value.startsWith("data:"))
    expect(updated.icon?.url).toContain("base64")
    expect(updated.icon?.color).toBeUndefined()
  })

  test("should not discover non-image files", async () => {
    const p = await loadProject()
    await using tmp = await tmpdir({ git: true })
    const { project } = await p.fromDirectory(tmp.path)

    await Filesystem.write(path.join(tmp.path, "favicon.txt"), "not an image")

    await p.discover(project)

    const updated = await Storage.read<ProjectNS.Info>(["project", project.id])
    expect(updated.icon).toBeUndefined()
  })
})
