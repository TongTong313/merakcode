import { afterEach, describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Engine } from "../src/engine"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), "merakcode-engine-"))
  dirs.push(dir)
  return dir
}

const dev = { MERAKCODE_APP_DEV_URL: "http://127.0.0.1:5173" }

describe("Engine.missing", () => {
  test("from source the built UI is required, unless the Vite dev server serves it", () => {
    const repo = temp()
    mkdirSync(path.join(repo, "apps", "cli", "src"), { recursive: true })
    writeFileSync(path.join(repo, "apps", "cli", "src", "index.ts"), "")
    const layout = { kind: "source", repo, node: "node" } as const
    expect(Engine.missing(layout, "")).toEqual([path.join(repo, "apps", "desktop", "renderer", "dist", "index.html")])
    expect(Engine.missing(layout, "", dev)).toEqual([])
  })

  test("an installed app always needs its built UI", () => {
    const resources = temp()
    const layout = { kind: "packaged", root: path.join(resources, "engine") } as const
    expect(Engine.missing(layout, resources, dev)).toContain(path.join(resources, "app-dist", "index.html"))
  })
})
