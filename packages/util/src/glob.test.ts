import { afterAll, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Glob } from "./glob"

let root = ""

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "glob-test-")))
  for (const file of ["a/x.json", "a/.hidden/y.json", ".top.json", "b/favicon.png", "c/deep/z.md"]) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), "")
  }
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const native = (file: string) => file.split("/").join(path.sep)

describe("Glob.scan", () => {
  test("returns files relative to cwd with native separators, skipping dot paths", async () => {
    expect((await Array.fromAsync(new Glob("**/*.json").scan({ cwd: root }))).sort()).toEqual([native("a/x.json")])
  })

  test("includes dot paths when asked", async () => {
    const found = (await Array.fromAsync(new Glob("**/*.json").scan({ cwd: root, dot: true }))).sort()
    expect(found).toEqual([native(".top.json"), native("a/.hidden/y.json"), native("a/x.json")].sort())
  })

  test("returns absolute paths when asked", async () => {
    expect(await Array.fromAsync(new Glob("a/*.json").scan({ cwd: root, absolute: true }))).toEqual([
      path.join(root, "a", "x.json"),
    ])
  })

  test("lists only files by default, directories without a trailing separator on request", () => {
    expect(new Glob("*").scanSync({ cwd: root }).sort()).toEqual([])
    expect(new Glob("*").scanSync({ cwd: root, onlyFiles: false }).sort()).toEqual(["a", "b", "c"])
  })

  test("expands a brace group with a single alternative", () => {
    expect(new Glob("**/{favicon}.{ico,png}").scanSync({ cwd: root })).toEqual([native("b/favicon.png")])
  })

  test("returns nothing for a missing directory", async () => {
    expect(await Array.fromAsync(new Glob("**/*").scan({ cwd: path.join(root, "missing") }))).toEqual([])
  })
})

describe("Glob.match", () => {
  test("matches dot paths by default", () => {
    expect(new Glob("**/*.json").match("a/.hidden/y.json")).toBe(true)
  })

  test("does not let a single star cross a directory", () => {
    expect(new Glob("*").match("a/b")).toBe(false)
    expect(new Glob("**/*.mdc").match("x.mdc")).toBe(true)
  })

  test("expands a brace group with a single alternative", () => {
    expect(new Glob("{favicon}.png").match("favicon.png")).toBe(true)
  })
})
