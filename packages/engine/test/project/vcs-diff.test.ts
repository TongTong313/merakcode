import { afterEach, describe, expect, test } from "vitest"
import * as fs from "fs/promises"
import path from "path"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Vcs } from "@merakcode/engine/app/project/vcs"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { Process } from "@merakcode/util/process"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("Vcs.diff", () => {
  test("returns an empty array when nothing changed", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await Vcs.diff({ mode: "git" })
        expect(result).toEqual([])
      },
    })
  })

  test("lists the patch and stats of a modified file", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "hello.txt")
    await fs.writeFile(file, "hello\n")
    await Process.run(["git", "add", "hello.txt"], { cwd: tmp.path })
    await Process.run(["git", "commit", "-m", "add hello"], { cwd: tmp.path })
    await fs.writeFile(file, "hello\nworld\n")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await Vcs.diff({ mode: "git" })
        expect(result.length).toBe(1)
        expect(result[0]?.file).toBe("hello.txt")
        expect(result[0]?.status).toBe("modified")
        expect(result[0]?.patch).toContain("+world")
        expect(result[0]?.additions).toBeGreaterThan(0)
      },
    })
  })

  test("batched patch covers changes across multiple files", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "a.txt"), "a\n")
    await fs.writeFile(path.join(tmp.path, "b.txt"), "b\n")
    await Process.run(["git", "add", "a.txt", "b.txt"], { cwd: tmp.path })
    await Process.run(["git", "commit", "-m", "add ab"], { cwd: tmp.path })
    await fs.writeFile(path.join(tmp.path, "a.txt"), "a2\n")
    await fs.writeFile(path.join(tmp.path, "b.txt"), "b2\n")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await Vcs.diff({ mode: "git" })
        expect(result.length).toBe(2)
        expect(result.find((item) => item.file === "a.txt")?.patch).toContain("+a2")
        expect(result.find((item) => item.file === "b.txt")?.patch).toContain("+b2")
      },
    })
  })

  test("lists untracked files", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "new.txt"), "brand new\n")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await Vcs.diff({ mode: "git" })
        expect(result.length).toBe(1)
        expect(result[0]?.file).toBe("new.txt")
        expect(result[0]?.status).toBe("added")
        expect(result[0]?.patch).toContain("brand new")
      },
    })
  })

  test("branch mode returns empty when only the main branch exists", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await Vcs.diff({ mode: "branch" })).toEqual([])
      },
    })
  })

  test("lists deleted files", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "remove.txt")
    await fs.writeFile(file, "gone\n")
    await Process.run(["git", "add", "remove.txt"], { cwd: tmp.path })
    await Process.run(["git", "commit", "-m", "add remove"], { cwd: tmp.path })
    await fs.rm(file)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await Vcs.diff({ mode: "git" })
        expect(result.length).toBe(1)
        expect(result[0]?.file).toBe("remove.txt")
        expect(result[0]?.status).toBe("deleted")
        expect(result[0]?.patch).toContain("-gone")
      },
    })
  })

  test("branch mode on a feature branch returns the diff against the main branch", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "base.txt"), "base\n")
    await Process.run(["git", "add", "base.txt"], { cwd: tmp.path })
    await Process.run(["git", "commit", "-m", "base"], { cwd: tmp.path })
    await Process.run(["git", "checkout", "-b", "feature"], { cwd: tmp.path })
    await fs.writeFile(path.join(tmp.path, "feature.txt"), "feature\n")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await Vcs.diff({ mode: "branch" })
        expect(result.some((item) => item.file === "feature.txt" && item.status === "added")).toBe(true)
      },
    })
  })

  test("last-turn mode returns empty because the last turn is served by session.diff", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await Vcs.diff({ mode: "last-turn" })).toEqual([])
      },
    })
  })

  test("returns empty for a non-git project", async () => {
    await using tmp = await tmpdir({ git: false })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await Vcs.diff({ mode: "git" })).toEqual([])
      },
    })
  })

  test("marks a file truncated and omits its patch when it exceeds the per-file limit", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "big.txt")
    await fs.writeFile(file, `${"line\n".repeat(200)}`)
    await Process.run(["git", "add", "big.txt"], { cwd: tmp.path })
    await Process.run(["git", "commit", "-m", "add big"], { cwd: tmp.path })
    await fs.writeFile(file, `${"line\n".repeat(200)}changed\n`)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await Vcs.diff({ mode: "git", maxPatchBytes: 80, maxTotalPatchBytes: 10_000 })
        expect(result.length).toBe(1)
        expect(result[0]?.truncated).toBe(true)
        expect(result[0]?.patch).not.toContain("changed")
        expect(result[0]?.additions).toBeGreaterThan(0)
      },
    })
  })

  test("marks files truncated when the total patch limit is exceeded", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "a.txt"), "a\n")
    await fs.writeFile(path.join(tmp.path, "b.txt"), "b\n")
    await Process.run(["git", "add", "a.txt", "b.txt"], { cwd: tmp.path })
    await Process.run(["git", "commit", "-m", "add ab"], { cwd: tmp.path })
    await fs.writeFile(path.join(tmp.path, "a.txt"), "a2\n")
    await fs.writeFile(path.join(tmp.path, "b.txt"), "b2\n")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await Vcs.diff({ mode: "git", maxPatchBytes: 10_000, maxTotalPatchBytes: 1 })
        expect(result.length).toBe(2)
        expect(result.every((item) => item.truncated)).toBe(true)
      },
    })
  })

  test("files within budget keep their patch when the total limit is exceeded", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "a.txt"), "a\n")
    await fs.writeFile(path.join(tmp.path, "b.txt"), "b\n")
    await Process.run(["git", "add", "a.txt", "b.txt"], { cwd: tmp.path })
    await Process.run(["git", "commit", "-m", "add ab"], { cwd: tmp.path })
    await fs.writeFile(path.join(tmp.path, "a.txt"), "a2\n")
    await fs.writeFile(path.join(tmp.path, "b.txt"), "b2\n")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await Vcs.diff({ mode: "git", maxPatchBytes: 10_000, maxTotalPatchBytes: 120 })
        const a = result.find((item) => item.file === "a.txt")
        const b = result.find((item) => item.file === "b.txt")
        expect(a?.truncated).toBeFalsy()
        expect(a?.patch).toContain("+a2")
        expect(b?.truncated).toBe(true)
      },
    })
  })
})
