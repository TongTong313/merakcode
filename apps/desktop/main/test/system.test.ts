import { describe, expect, test } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { System } from "../src/system"

describe("editor command lookup", () => {
  test("finds commands on PATH (only PATHEXT extensions on Windows) and returns undefined when missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "merakcode-which-"))
    const win = process.platform === "win32"
    try {
      writeFileSync(path.join(dir, "code"), "")
      if (win) writeFileSync(path.join(dir, "code.cmd"), "")
      writeFileSync(path.join(dir, win ? "subl.exe" : "subl"), "")
      const env = { PATH: dir, PATHEXT: ".EXE;.CMD" }
      expect(System.which("code", env)).toBe(path.join(dir, win ? "code.cmd" : "code"))
      expect(System.which("Sublime Text", env)).toBe(path.join(dir, win ? "subl.exe" : "subl"))
      expect(System.which("zed", env)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("clipboard files", () => {
  test("merges file manager URIs (non-ASCII, spaces) and plain-text absolute paths without duplicates", () => {
    const dir = path.join(tmpdir(), "clip dir")
    const uris = [
      pathToFileURL(path.join(dir, "项目 一.txt")).href,
      pathToFileURL(path.join(tmpdir(), "b.txt")).href,
    ].join("\r\n")
    const text = [path.join(tmpdir(), "b.txt"), "not a path", "relative/c"].join("\n")
    expect(System.clipboardFiles(uris, text)).toEqual([path.join(dir, "项目 一.txt"), path.join(tmpdir(), "b.txt")])
    expect(System.clipboardFiles("", "")).toEqual([])
  })
})

describe("local files", () => {
  test("writeText creates directories and readText returns null for a missing file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "merakcode-files-"))
    try {
      expect(await System.writeText(path.join(dir, "sub", "a.txt"), "你好")).toBe(true)
      expect(await System.readText(path.join(dir, "sub", "a.txt"))).toBe("你好")
      expect(await System.readText(path.join(dir, "missing.txt"))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
