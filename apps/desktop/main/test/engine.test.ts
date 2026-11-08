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
    const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
    const binary = path.join(repo, "merak", "dist", target, process.platform === "win32" ? "merak.exe" : "merak")
    const layout = { kind: "source", repo } as const
    expect(Engine.missing(layout, "", dev)).toContain(binary)
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, "")
    expect(Engine.missing(layout, "")).toEqual([path.join(repo, "apps", "desktop", "renderer", "dist", "index.html")])
    expect(Engine.missing(layout, "", dev)).toEqual([])
  })

  test("an installed app always needs its built UI", () => {
    const resources = temp()
    const layout = Engine.layout({ packaged: true, resources, here: "", env: {} })
    expect(Engine.missing(layout, resources, dev)).toContain(path.join(resources, "app-dist", "index.html"))
    expect(Engine.command(layout)).toEqual([
      path.join(resources, "merak", process.platform === "win32" ? "merak.exe" : "merak"),
    ])
    expect(Engine.missing(layout, resources, dev)).toContain(Engine.command(layout)[0])
  })
})
