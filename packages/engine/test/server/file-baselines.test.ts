import { expect, test } from "vitest"
import { createMerakCodeClient } from "@merakcode/sdk/client"
import { Server } from "@merakcode/engine/app/server/server"
import { Process } from "@merakcode/util/process"
import { tmpdir } from "../fixture/fixture"
import { writeFile, unlink } from "node:fs/promises"
import path from "node:path"

test("file reads distinguish the committed, staged and working contents through the SDK", async () => {
  await using root = await tmpdir({ git: true })
  const file = path.join(root.path, "example.txt")
  await writeFile(file, "committed\n")
  await Process.run(["git", "add", "."], { cwd: root.path })
  await Process.run(["git", "commit", "-m", "fixture"], { cwd: root.path })
  await writeFile(file, "staged\n")
  await Process.run(["git", "add", "."], { cwd: root.path })
  await writeFile(file, "working\n")
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path })
    const result = await client.file.read({ path: "example.txt" })
    expect(result.data).toMatchObject({ content: "working\n", baselines: { head: "committed\n", index: "staged\n" } })
  } finally {
    await server.stop(true)
  }
})

test("file status distinguishes staged additions and deletions from modifications", async () => {
  await using root = await tmpdir({ git: true })
  for (const file of ["modified.txt", "deleted.txt"]) await writeFile(path.join(root.path, file), "original\n")
  await Process.run(["git", "add", "."], { cwd: root.path })
  await Process.run(["git", "commit", "-m", "fixture"], { cwd: root.path })
  await writeFile(path.join(root.path, "added.txt"), "new\n")
  await writeFile(path.join(root.path, "modified.txt"), "modified\n")
  await unlink(path.join(root.path, "deleted.txt"))
  await Process.run(["git", "add", "."], { cwd: root.path })
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path })
    const result = await client.file.status()
    expect(result.data?.map((file) => [file.path, file.status]).sort()).toEqual([
      ["added.txt", "added"],
      ["deleted.txt", "deleted"],
      ["modified.txt", "modified"],
    ])
  } finally {
    await server.stop(true)
  }
})
