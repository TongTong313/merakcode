/**
 * The @merakcode/sdk package published to npm: compiled JS and type declarations without the repo's private packages;
 * the engine comes from the same platform packages as the CLI (optional dependencies at the SDK's version); the
 * client and state parts work in browsers.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { build as esbuild } from "esbuild"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { build } from "../script/build"

let outdir: string
let manifest: {
  name: string
  version: string
  private?: boolean
  engines: { node: string }
  exports: Record<string, { types: string; default: string }>
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
}

beforeAll(async () => {
  outdir = await mkdtemp(path.join(os.tmpdir(), "merakcode-sdk-package-"))
  await build({ outdir, version: "1.2.0", platforms: ["merakcode-linux-x64", "merakcode-windows-x64"] })
  manifest = JSON.parse(await readFile(path.join(outdir, "package.json"), "utf8"))
}, 120_000)

afterAll(() => rm(outdir, { recursive: true, force: true }))

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? files(path.join(dir, entry.name)) : Promise.resolve([path.join(dir, entry.name)]),
    ),
  )
  return nested.flat()
}

describe("npm package", () => {
  test("uses the CLI version, lists platform packages as optional dependencies, requires Node 24", () => {
    expect(manifest).toMatchObject({ name: "@merakcode/sdk", version: "1.2.0", engines: { node: ">=24" } })
    expect(manifest.private).toBeUndefined()
    expect(manifest.optionalDependencies).toEqual({ "merakcode-linux-x64": "1.2.0", "merakcode-windows-x64": "1.2.0" })
  })

  test("every public entry ships both JS and type declarations", async () => {
    expect(Object.keys(manifest.exports)).toEqual([
      ".",
      "./client",
      "./errors",
      "./store",
      "./process",
      "./plugin",
      "./transcript",
    ])
    const present = new Set(
      (await files(outdir)).map((file) => "./" + path.relative(outdir, file).replaceAll("\\", "/")),
    )
    for (const entry of Object.values(manifest.exports)) {
      expect(present).toContain(entry.default)
      expect(present).toContain(entry.types)
    }
  })

  test("ships the README for the npm page, the license and third-party notices", async () => {
    const names = (await readdir(outdir)).sort()
    expect(names).toEqual(expect.arrayContaining(["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]))
    expect(await readFile(path.join(outdir, "README.md"), "utf8")).toContain("npm install @merakcode/sdk")
  })

  test("pins dependencies to exact versions and excludes the repo's private packages", async () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["undici", "zod"])
    for (const version of Object.values(manifest.dependencies)) expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    for (const file of await files(outdir)) {
      if (!/\.(js|d\.ts)$/.test(file)) continue
      expect(await readFile(file, "utf8"), file).not.toMatch(/@merakcode\/(util|log|engine)/)
    }
  })

  test("browser bundles of the client and state parts contain no node: modules", async () => {
    for (const entry of ["./client", "./errors", "./store"]) {
      const result = await esbuild({
        entryPoints: [path.join(outdir, manifest.exports[entry]!.default)],
        bundle: true,
        platform: "browser",
        format: "esm",
        write: false,
        external: ["zod"],
        logLevel: "silent",
      })
      expect(result.outputFiles[0]!.text, entry).not.toMatch(/["']node:/)
    }
  })
})
