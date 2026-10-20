import { afterEach, describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Version } from "./version"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

/** A small workspace laid out like the real one */
function workspace(versions: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "version-"))
  roots.push(root)
  for (const [dir, version] of Object.entries(versions)) {
    mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(
      path.join(root, dir, "package.json"),
      `{\n  "name": "${dir || "root"}",\n  "version": "${version}",\n  "dependencies": {\n    "x": "1.0.0"\n  }\n}\n`,
    )
  }
  return root
}

const layout = {
  "": "0.1.0",
  "apps/cli": "0.1.0",
  "apps/desktop/main": "0.1.0",
  "packages/util": "0.1.0",
  "packages/sdk/js": "0.1.0",
}

describe("Version.valid", () => {
  test("x.y.z with an optional pre-release like beta.1", () => {
    for (const version of ["0.2.0", "1.10.3", "0.2.0-beta.1", "1.0.0-rc.2"])
      expect(Version.valid(version), version).toBe(true)
    for (const version of ["v0.2.0", "0.2", "0.2.0-", "0.2.0-beta..1", "01.2.3", "1.2.3+build"])
      expect(Version.valid(version), version).toBe(false)
  })
})

describe("Version.set", () => {
  test("changes every package and returns the files it changed; other version fields stay", () => {
    const root = workspace(layout)
    const changed = Version.set(root, "0.2.0-beta.1")
    expect(changed.map((file) => path.relative(root, file).replaceAll("\\", "/")).sort()).toEqual(
      [
        "package.json",
        "apps/cli/package.json",
        "apps/desktop/main/package.json",
        "packages/util/package.json",
        "packages/sdk/js/package.json",
      ].sort(),
    )
    for (const file of changed) {
      const text = readFileSync(file, "utf8")
      expect(JSON.parse(text).version).toBe("0.2.0-beta.1")
      expect(JSON.parse(text).dependencies.x).toBe("1.0.0")
    }
    expect(Version.check(root)).toEqual({ ok: true, version: "0.2.0-beta.1", mismatched: [] })
  })

  test("refuses an invalid version and changes nothing", () => {
    const root = workspace(layout)
    expect(() => Version.set(root, "v1")).toThrow(/version/i)
    expect(Version.check(root).version).toBe("0.1.0")
  })

  test("setting the current version changes nothing", () => {
    expect(Version.set(workspace(layout), "0.1.0")).toEqual([])
  })
})

describe("Version.check", () => {
  test("names the packages whose version differs from the root", () => {
    const root = workspace({ ...layout, "packages/util": "0.1.1" })
    const result = Version.check(root)
    expect(result.ok).toBe(false)
    expect(result.mismatched).toEqual([{ file: "packages/util/package.json", version: "0.1.1" }])
  })
})
