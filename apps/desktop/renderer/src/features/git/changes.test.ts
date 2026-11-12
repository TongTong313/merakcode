import { execFileSync } from "node:child_process"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createRoot } from "solid-js"
import { afterAll, beforeAll, expect, test } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { changesOf, useGitChanges } from "./changes"

let env: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
  await writeFile(path.join(env.project, "a.txt"), "a\n")
  await env.git("add", ".")
  await env.git("commit", "-m", "initial")
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})

test("staging and unstaging move files between the groups, and a staged commit leaves the others alone", async () => {
  await writeFile(path.join(env.project, "a.txt"), "changed\n")
  await writeFile(path.join(env.project, "b.txt"), "new\n")
  const { changes, dispose } = createRoot((dispose) => ({ changes: useGitChanges(() => env.project), dispose }))
  try {
    await expect.poll(() => changes.data()?.unstaged.length).toBe(2)
    await changes.change("stage", [{ file: "a.txt", status: "modified" }])
    expect(changes.data()?.staged.map((file) => file.file)).toEqual(["a.txt"])
    expect(changes.data()?.unstaged.map((file) => file.file)).toEqual(["b.txt"])
    await changes.change("unstage", [{ file: "a.txt", status: "modified" }])
    expect(changes.data()?.staged).toEqual([])
    await changes.change("stage", [{ file: "a.txt", status: "modified" }])
    const connection = await client()
    const committed = await connection.repo.commit({ directory: env.project, message: "Only a", staged: true })
    expect(committed.commit).toBe(await env.git("rev-parse", "HEAD"))
    expect(await env.git("show", "--name-only", "--format=", "HEAD")).toBe("a.txt")
    await changes.refresh()
    expect(changes.data()?.unstaged.map((file) => file.file)).toEqual(["b.txt"])
    expect(changesOf(env.project)?.staged).toEqual([])
  } finally {
    dispose()
  }
})

test("the summary says when a push has somewhere to go and what it still has to send", async () => {
  const remote = path.join(env.project, "..", "remote.git")
  execFileSync("git", ["init", "--bare", "--quiet", remote])
  await env.git("remote", "add", "origin", remote)
  const { changes, dispose } = createRoot((dispose) => ({ changes: useGitChanges(() => env.project), dispose }))
  try {
    await changes.refresh()
    expect(changes.data()).toMatchObject({ remote: "origin", upstream: false })
    await (await client()).repo.push({ directory: env.project })
    await changes.refresh()
    expect(changes.data()).toMatchObject({ remote: "origin", upstream: true, ahead: 0 })
    await writeFile(path.join(env.project, "b.txt"), "newer\n")
    await env.git("add", "b.txt")
    await env.git("commit", "-m", "More")
    await changes.refresh()
    expect(changes.data()?.ahead).toBe(1)
  } finally {
    dispose()
  }
})
