import { mkdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import { engineFixture } from "../test/engine"
import { client } from "./client"
import {
  checkoutOf,
  gitState,
  registerDirty,
  refreshBranches,
  resolveDirectory,
  switchBranch,
  unsavedReason,
} from "./git"

let env: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
  await writeFile(path.join(env.project, "note.txt"), "note\n")
  await env.git("add", ".")
  await env.git("commit", "-m", "initial")
  await env.git("branch", "feature")
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})

test("a subdirectory resolves to its checkout root and shares its branch state", async () => {
  const sub = path.join(env.project, "sub")
  await mkdir(sub)
  const options = await refreshBranches(sub)
  expect(await realpath(options!.directory)).toBe(await realpath(sub))
  expect(options?.branches.map((branch) => branch.name).sort()).toEqual(["feature", "main"])
  expect(await resolveDirectory(sub)).toBe(options!.directory)
  expect(checkoutOf(sub)).toMatch(/^main:/)
})

test("a forced refresh does not reuse a lookup that began before a branch was created", async () => {
  const stale = refreshBranches(env.project)
  await env.git("branch", "late")
  const forced = refreshBranches(env.project, { force: true })
  expect(refreshBranches(env.project)).toBe(forced)
  expect((await forced)?.branches.map((branch) => branch.name)).toContain("late")
  await stale
})

test("switching changes the real checkout, and unsaved work blocks it until it is cleared", async () => {
  registerDirty(env.project, `editor:${env.project}`, 1)
  expect(unsavedReason(env.project)).toBeTruthy()
  await expect(switchBranch(env.project, "feature")).rejects.toThrow()
  expect(await env.git("branch", "--show-current")).toBe("main")
  registerDirty(env.project, `editor:${env.project}`, 0)
  const current = await switchBranch(env.project, "feature")
  expect(current?.branch).toBe("feature")
  expect(await env.git("branch", "--show-current")).toBe("feature")
  await expect(switchBranch(env.project, "missing")).rejects.toThrow()
  expect(gitState(env.project)?.switching).toBe(false)
  await switchBranch(env.project, "main")
})

test("a folder outside any repository is reported as such and cannot switch", async () => {
  const plain = path.join(env.project, "..", "plain")
  await mkdir(plain)
  const options = await refreshBranches(plain)
  expect(options?.blocked?.reason).toBe("not_git")
  await expect(switchBranch(plain, "main")).rejects.toThrow()
})
