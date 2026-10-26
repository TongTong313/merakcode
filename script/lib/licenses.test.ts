import { afterEach, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { merge, owners, render } from "./licenses"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

/** A package directory with the given package.json, inside a fresh node_modules */
async function installed(name: string, manifest: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "licenses-test-"))
  dirs.push(root)
  const dir = path.join(root, "node_modules", ".pnpm", "x@1.0.0", "node_modules", ...name.split("/"))
  await fs.mkdir(path.join(dir, "lib"), { recursive: true })
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name, ...manifest }))
  return dir
}

describe("licenses", () => {
  test("merges lists from several sources without duplicates, sorted by name", () => {
    const merged = merge([
      [
        { name: "zod", versions: ["4.0.0"], license: "MIT", paths: ["/a/zod"] },
        { name: "hono", versions: ["4.1.0"], license: "MIT", paths: ["/a/hono"] },
      ],
      [{ name: "zod", versions: ["4.0.0", "3.0.0"], license: "MIT", paths: ["/b/zod"] }],
      [{ name: "@merakcode/util", versions: ["0.1.2"], license: "MIT", paths: ["/c/util"] }],
    ])
    expect(merged.map((entry) => [entry.name, entry.versions])).toEqual([
      ["hono", ["4.1.0"]],
      ["zod", ["3.0.0", "4.0.0"]],
    ])
  })

  test("maps bundled files to the npm packages that own them", async () => {
    const scoped = await installed("@zip.js/zip.js", { version: "2.7.0", license: "BSD-3-Clause" })
    const plain = await installed("cross-spawn", { version: "7.0.6", licenses: [{ type: "MIT" }] })
    const entries = owners([
      path.join(scoped, "lib", "a.js"),
      path.join(scoped, "lib", "b.js"),
      path.join(plain, "index.js"),
      path.join(os.tmpdir(), "packages", "log", "src", "index.ts"),
    ])
    expect(entries).toEqual([
      { name: "@zip.js/zip.js", versions: ["2.7.0"], license: "BSD-3-Clause", paths: [scoped] },
      { name: "cross-spawn", versions: ["7.0.6"], license: "MIT", paths: [plain] },
    ])
  })

  test("renders each package with its license text, or the license id when no file is found", () => {
    const text = render(
      [
        { name: "hono", versions: ["4.1.0"], license: "MIT", paths: ["/a/hono"] },
        { name: "tiny", versions: ["1.0.0"], license: "ISC", paths: ["/a/tiny"] },
      ],
      (dir) => (dir === "/a/hono" ? "MIT License\n\nCopyright (c) Yusuke Wada" : undefined),
    )
    expect(text).toContain("hono@4.1.0 (MIT)")
    expect(text).toContain("Copyright (c) Yusuke Wada")
    expect(text).toContain("tiny@1.0.0 (ISC)")
    expect(text).toContain("License text not included in the package; see the ISC license.")
  })
})
