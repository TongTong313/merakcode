import { expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import { createMerakCodeClient } from "@merakcode/sdk/client"
import { Server } from "@merakcode/engine/app/server/server"
import { Process } from "@merakcode/util/process"
import { tmpdir } from "../fixture/fixture"
import { readFile, writeFile, unlink, access } from "node:fs/promises"
import path from "node:path"

test("SDK session recovery retries project discovery after a missing directory reconnects", async () => {
  await using root = await tmpdir()
  await using actual = await tmpdir({ git: true })
  const alias = path.join(root.path, "old-link")
  await fs.symlink(actual.path, alias, process.platform === "win32" ? "junction" : "dir")
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const client = createMerakCodeClient({ baseUrl: server.url.href, directory: alias })
    const session = await client.session.create({ title: "Retained review" })
    expect(session.data?.projectID).not.toBe("global")
    await unlink(alias)
    expect((await client.instance.dispose()).data).toBe(true)
    const offline = await client.path.get()
    expect(offline.response?.status).toBeGreaterThanOrEqual(400)
    expect(offline.data).toBeUndefined()
    await fs.symlink(actual.path, alias, process.platform === "win32" ? "junction" : "dir")
    const restored = await client.session.get({ sessionID: session.data!.id })
    expect(restored.response?.status).toBe(200)
    expect(restored.data).toMatchObject({ id: session.data!.id, title: "Retained review" })
  } finally {
    await server.stop(true)
  }
})

test("SDK identity rejects missing and non-directory roots but resolves a reconnected root link", async () => {
  await using root = await tmpdir()
  const actual = path.join(root.path, "actual")
  const alias = path.join(root.path, "old-link")
  await fs.mkdir(actual)
  await writeFile(path.join(actual, "notes.txt"), "original")
  await fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir")
  await unlink(alias)
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const client = createMerakCodeClient({ baseUrl: server.url.href, directory: alias })
    const missing = await client.file.identity({ path: "." })
    expect(missing.response?.status).toBeGreaterThanOrEqual(400)
    expect(missing.data).toBeUndefined()
    await writeFile(alias, "not a directory")
    expect((await client.file.identity({ path: "." })).response?.status).toBeGreaterThanOrEqual(400)
    await unlink(alias)
    await fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir")
    const recovered = await client.file.identity({ path: "notes.txt" })
    expect(recovered.response?.status).toBe(200)
    expect(recovered.data).toEqual({ directory: await fs.realpath(actual), path: "notes.txt" })
  } finally {
    await server.stop(true)
  }
})

test("SDK identity can resolve a readable file when an ancestor cannot be listed", async () => {
  await using root = await tmpdir({ git: true })
  const file = path.join(root.path, "notes.txt")
  await writeFile(file, "readable contents")
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path })
  const ancestor = path.dirname(await fs.realpath(root.path))
  const original = fs.readdir.bind(fs)
  let listing: ReturnType<typeof vi.spyOn> | undefined
  try {
    expect((await client.file.read({ path: "notes.txt" })).data?.content).toBe("readable contents")
    const before = await client.file.identity({ path: "notes.txt" })
    expect(before.response?.status).toBe(200)
    listing = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (String(args[0]) === ancestor) throw Object.assign(new Error("Directory listing denied"), { code: "EACCES" })
      return Reflect.apply(original, fs, args)
    })
    const result = await client.file.identity({ path: "notes.txt" })
    expect(result.response?.status).toBe(200)
    expect(result.data).toEqual(before.data)
    expect((await client.file.read({ path: "notes.txt" })).data?.content).toBe("readable contents")
  } finally {
    listing?.mockRestore()
    await server.stop(true)
  }
})

test("SDK file identities preserve real spelling and distinguish case-sensitive files", async () => {
  await using root = await tmpdir({ git: true })
  await fs.mkdir(path.join(root.path, "Folder"))
  await writeFile(path.join(root.path, "Folder", "Notes.txt"), "upper")
  const aliasExists = await readFile(path.join(root.path, "Folder", "notes.txt"), "utf8").then(
    () => true,
    () => false,
  )
  if (!aliasExists) await writeFile(path.join(root.path, "Folder", "notes.txt"), "lower")
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path })
    expect((await client.file.identity({ path: "Folder/./Notes.txt" })).data?.path).toBe("Folder/Notes.txt")
    expect((await client.file.identity({ path: "Folder/notes.txt" })).data?.path).toBe(
      aliasExists ? "Folder/Notes.txt" : "Folder/notes.txt",
    )
    expect((await client.file.identity({ path: "Folder/Missing.txt" })).data?.path).toBe("Folder/Missing.txt")
  } finally {
    await server.stop(true)
  }
})

test("SDK identities retain directory aliases after files and nested parents are deleted", async () => {
  await using root = await tmpdir({ git: true })
  const actual = path.join(root.path, "actual")
  const alias = path.join(root.path, "alias")
  await fs.mkdir(path.join(actual, "nested"), { recursive: true })
  await writeFile(path.join(actual, "nested", "notes.txt"), "original")
  await fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir")
  expect(await fs.realpath(alias)).toBe(await fs.realpath(actual))
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path })
    const identity = (value: string) =>
      client.file.identity({ path: value }).then((result) => {
        expect(result.response?.status).toBe(200)
        return result.data
      })
    const before = await identity("actual/nested/notes.txt")
    expect(before?.path).toBe("actual/nested/notes.txt")
    expect(await identity("alias/nested/notes.txt")).toEqual(before)
    await unlink(path.join(actual, "nested", "notes.txt"))
    expect(await identity("actual/nested/notes.txt")).toEqual(before)
    expect(await identity("alias/nested/notes.txt")).toEqual(before)
    await fs.rmdir(path.join(actual, "nested"))
    expect(await identity("alias/nested/notes.txt")).toEqual(before)
    expect(await identity("alias/nested/../nested/notes.txt")).toEqual(before)
    await fs.symlink(
      path.join(actual, "missing"),
      path.join(actual, "broken"),
      process.platform === "win32" ? "junction" : "dir",
    )
    const broken = await identity("actual/broken/notes.txt")
    expect(broken?.path).toBe("actual/broken/notes.txt")
    expect(await identity("alias/broken/notes.txt")).toEqual(broken)
  } finally {
    await server.stop(true)
  }
})

test("SDK file identity belongs to the actual root in a multi-root workspace", async () => {
  await using primary = await tmpdir({ git: true })
  await using secondary = await tmpdir({ git: true })
  const file = path.join(secondary.path, "notes.txt")
  await writeFile(file, "secondary")
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const client = createMerakCodeClient({
      baseUrl: server.url.href,
      directory: primary.path,
      headers: {
        "x-merakcode-workspace-folders": encodeURIComponent(
          JSON.stringify([{ path: primary.path }, { path: secondary.path }]),
        ),
      },
    })
    const direct = createMerakCodeClient({ baseUrl: server.url.href, directory: secondary.path })
    expect((await client.file.identity({ path: file })).data).toEqual(
      (await direct.file.identity({ path: "notes.txt" })).data,
    )
  } finally {
    await server.stop(true)
  }
})

test("an SDK save prevents an external checkout throughout the disk write", async () => {
  await using root = await tmpdir({ git: true })
  const file = path.join(root.path, "example.txt")
  await writeFile(file, "original\n")
  const git = (...args: string[]) => Process.run(["git", ...args], { cwd: root.path, nothrow: true })
  await git("add", ".")
  await git("commit", "-m", "fixture")
  await git("branch", "feature")
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const arrived = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const original = fs.writeFile.bind(fs)
  const write = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (String(args[0]) === file && args[1] === "saved draft\n") {
      arrived.resolve()
      await resume.promise
    }
    return original(...args)
  })
  let request: Promise<unknown> | undefined
  try {
    const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path })
    const before = await client.vcs.branchOptions()
    const content = await client.file.read({ path: "example.txt" })
    const saving = client.file.write({
      path: "example.txt",
      content: "saved draft\n",
      checksum: content.data!.checksum,
      expectedCheckout: before.data!.current!.checkout,
    })
    request = saving
    await arrived.promise
    const switching = await git("switch", "feature")
    resume.resolve()
    const result = await saving
    expect(switching.exitCode).not.toBe(0)
    expect(result.response?.status).toBe(200)
    expect((await git("branch", "--show-current")).text().trim()).toBe(before.data!.current!.branch)
    expect(await readFile(file, "utf8")).toBe("saved draft\n")
    expect((await git("switch", "feature")).exitCode).toBe(0)
  } finally {
    resume.resolve()
    await request
    write.mockRestore()
    await server.stop(true)
  }
})

test("SDK saves release their own index lock on failure and preserve another Git process lock", async () => {
  await using root = await tmpdir({ git: true })
  const file = path.join(root.path, "example.txt")
  const lock = path.join(root.path, ".git", "index.lock")
  await writeFile(file, "original\n")
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const original = fs.writeFile.bind(fs)
  const write = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (String(args[0]) === file) throw new Error("disk write failed")
    return original(...args)
  })
  try {
    const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path })
    const failed = await client.file.write({ path: "example.txt", content: "unsaved" })
    expect(failed.response?.status).toBe(500)
    await expect(access(lock)).rejects.toMatchObject({ code: "ENOENT" })
    write.mockRestore()
    await writeFile(lock, "another Git operation")
    const blocked = await client.file.write({ path: "example.txt", content: "unsaved" })
    expect(blocked.response?.status).toBe(409)
    expect(await readFile(lock, "utf8")).toBe("another Git operation")
    expect(await readFile(file, "utf8")).toBe("original\n")
  } finally {
    write.mockRestore()
    await unlink(lock).catch(() => {})
    await server.stop(true)
  }
})

test("concurrent SDK saves in one worktree wait for each other and all succeed", async () => {
  await using root = await tmpdir({ git: true })
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path })
    const before = await client.vcs.branchOptions()
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        client.file.write({
          path: `file-${index}.txt`,
          content: `draft ${index}`,
          expectedCheckout: before.data!.current!.checkout,
        }),
      ),
    )
    expect(results.map((result) => result.response?.status)).toEqual(Array(8).fill(200))
    for (let index = 0; index < 8; index++)
      expect(await readFile(path.join(root.path, `file-${index}.txt`), "utf8")).toBe(`draft ${index}`)
  } finally {
    await server.stop(true)
  }
})

test("a held save does not block checkout in a separate worktree", async () => {
  await using root = await tmpdir({ git: true })
  const worktree = path.join(root.path, "other")
  const git = (...args: string[]) => Process.run(["git", ...args], { cwd: root.path })
  await git("worktree", "add", "-b", "other", worktree)
  await git("branch", "feature")
  const file = path.join(worktree, "example.txt")
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const arrived = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const original = fs.writeFile.bind(fs)
  const write = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (String(args[0]) === file) {
      arrived.resolve()
      await resume.promise
    }
    return original(...args)
  })
  let request: Promise<unknown> | undefined
  try {
    const client = createMerakCodeClient({ baseUrl: server.url.href, directory: worktree })
    const before = await client.vcs.branchOptions()
    const saving = client.file.write({
      path: "example.txt",
      content: "other draft",
      expectedCheckout: before.data!.current!.checkout,
    })
    request = saving
    await arrived.promise
    expect((await git("switch", "feature")).exitCode).toBe(0)
    const blocked = await Process.run(["git", "switch", "--detach", "HEAD"], { cwd: worktree, nothrow: true })
    expect(blocked.exitCode).not.toBe(0)
    resume.resolve()
    expect((await saving).response?.status).toBe(200)
    expect(await readFile(file, "utf8")).toBe("other draft")
  } finally {
    resume.resolve()
    await request
    write.mockRestore()
    await server.stop(true)
  }
})

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

test("an SDK file save rejects a checkout changed after reading an identical file", async () => {
  await using root = await tmpdir({ git: true })
  const file = path.join(root.path, "example.txt")
  await writeFile(file, "original\n")
  await Process.run(["git", "add", "."], { cwd: root.path })
  await Process.run(["git", "commit", "-m", "fixture"], { cwd: root.path })
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path })
    const before = await client.vcs.branchOptions()
    const content = await client.file.read({ path: "example.txt" })
    await Process.run(["git", "switch", "-c", "feature"], { cwd: root.path })
    const input = {
      path: "example.txt",
      content: "wrong branch\n",
      checksum: content.data!.checksum,
      expectedCheckout: before.data!.current!.checkout,
    }
    const result = await client.file.write(input)
    expect(result.response?.status).toBe(409)
    expect(await readFile(file, "utf8")).toBe("original\n")
  } finally {
    await server.stop(true)
  }
})
