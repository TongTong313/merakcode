import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readRoots } from "./read-roots"

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "read-roots-"))
  for (const dir of ["etc", "home/u/.ssh", "home/u/docs", "home/u/.config/gcloud", "home/u/.config/other", "home/v"])
    mkdirSync(path.join(root, dir), { recursive: true })
  writeFileSync(path.join(root, "etc", "passwd"), "x")
  writeFileSync(path.join(root, "home", "u", ".ssh", "id_rsa"), "key")
  writeFileSync(path.join(root, "home", "u", ".profile"), "x")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const at = (...parts: string[]) => path.join(root, ...parts)

describe("readRoots", () => {
  test("nothing denied: the whole tree", () => {
    expect(readRoots([], root)).toEqual([root])
  })

  test("a denied folder is left out; its siblings and its ancestors' siblings stay readable", () => {
    const roots = readRoots([at("home", "u", ".ssh")], root)
    expect(roots.sort()).toEqual(
      [
        at("etc"),
        at("home", "v"),
        at("home", "u", "docs"),
        at("home", "u", ".config"),
        at("home", "u", ".profile"),
      ].sort(),
    )
  })

  test("a nested denied folder keeps its siblings", () => {
    const roots = readRoots([at("home", "u", ".config", "gcloud")], root)
    expect(roots).toContain(at("home", "u", ".config", "other"))
    expect(roots).toContain(at("home", "u", ".ssh"))
    expect(roots).not.toContain(at("home", "u", ".config"))
    expect(roots.some((dir) => dir.startsWith(at("home", "u", ".config", "gcloud")))).toBe(false)
  })

  test("a denied path that does not exist changes nothing", () => {
    expect(readRoots([at("home", "u", ".aws")], root)).toEqual([root])
  })

  test("several denied folders under one ancestor are all left out", () => {
    const roots = readRoots([at("home", "u", ".ssh"), at("home", "u", ".config", "gcloud")], root)
    expect(roots).toContain(at("home", "u", "docs"))
    expect(roots).toContain(at("home", "u", ".config", "other"))
    expect(roots.some((dir) => dir.includes(".ssh") || dir.includes("gcloud"))).toBe(false)
  })

  test("denying the root itself leaves nothing", () => {
    expect(readRoots([root], root)).toEqual([])
  })
})
