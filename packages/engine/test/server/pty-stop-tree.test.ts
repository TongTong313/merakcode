import { expect, test } from "vitest"
import { createMerakCodeClient } from "@merakcode/sdk/client"
import { Server } from "@merakcode/engine/app/server/server"
import { tmpdir } from "../fixture/fixture"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Process } from "@merakcode/util/process"

test("removing a terminal waits for its detached descendants to stop through the SDK", async () => {
  await using root = await tmpdir({ git: true })
  const script = path.join(root.path, "family.mjs")
  const pids = path.join(root.path, "pids.txt")
  await writeFile(
    script,
    `import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n')
if (!process.argv[2]) spawn(process.execPath, [import.meta.filename, 'child'], { detached: true, stdio: 'ignore' }).unref()
setInterval(() => {}, 100)
`,
  )
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path })
  const ids = async () => (await readFile(pids, "utf8").catch(() => "")).trim().split(/\s+/).filter(Boolean).map(Number)
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  try {
    const created = await client.pty.create({ command: process.execPath, args: [script] })
    expect(created.error).toBeUndefined()
    await expect.poll(async () => (await ids()).length).toBe(2)
    const family = await ids()
    const removed = await client.pty.remove({ ptyID: created.data!.id })
    expect(removed.error).toBeUndefined()
    expect(family.filter(alive)).toEqual([])
  } finally {
    for (const pid of await ids())
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
    await server.stop(true)
  }
}, 30_000)

test("a closed terminal owner rejects late creation without stopping another conversation", async () => {
  await using root = await tmpdir({ git: true })
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path })
  let otherID: string | undefined
  try {
    const a = await client.session.create({})
    const b = await client.session.create({})
    const owner = { sessionID: a.data!.id, tabID: "closed-tab" }
    const other = await client.pty.create({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      owner: { sessionID: b.data!.id, tabID: "other-tab" },
    })
    otherID = other.data!.id
    await client.pty.closeOwned({ owner })
    const late = await client.pty.create({ owner })
    expect(late.response?.status).toBe(409)
    expect((await client.pty.get({ ptyID: otherID })).data?.status).toBe("running")
    await client.session.delete({ sessionID: b.data!.id })
    expect((await client.pty.get({ ptyID: otherID })).response?.status).toBe(404)
  } finally {
    if (otherID) await client.pty.remove({ ptyID: otherID })
    await server.stop(true)
  }
})

test("terminal Node preloads run in the user command after containment, without running in the launcher", async () => {
  await using root = await tmpdir({ git: true })
  const preload = path.join(root.path, "preload.cjs")
  const pids = path.join(root.path, "preload-pids.txt")
  const ready = path.join(root.path, "ready.txt")
  await writeFile(preload, `require('node:fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n')`)
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path })
  let id: string | undefined
  try {
    const created = await client.pty.create({
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 100)`],
      env: { NODE_OPTIONS: `--require "${preload.replaceAll("\\", "/")}"` },
    })
    expect(created.error).toBeUndefined()
    id = created.data!.id
    await expect.poll(() => readFile(ready, "utf8").catch(() => "")).toBe("ready")
    const observed = (await readFile(pids, "utf8")).trim().split(/\s+/).map(Number)
    expect(observed).toHaveLength(1)
    expect(observed[0]).not.toBe(created.data!.pid)
  } finally {
    if (id) await client.pty.remove({ ptyID: id })
    await server.stop(true)
  }
})

test("deleting a session stops its terminal created before promotion in another workspace", async () => {
  await using initial = await tmpdir({ git: true })
  await using destination = await tmpdir()
  await Process.run(["git", "worktree", "add", "--quiet", "-b", "terminal-target", destination.path], {
    cwd: initial.path,
  })
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const before = createMerakCodeClient({ baseUrl: server.url.href, directory: initial.path })
  const after = createMerakCodeClient({ baseUrl: server.url.href, directory: destination.path })
  let id: string | undefined
  try {
    const created = await before.pty.create({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 100)"],
      owner: { tabID: "cross-workspace" },
    })
    expect(created.error).toBeUndefined()
    id = created.data!.id
    const session = await after.session.create({})
    const rebound = await before.pty.update({
      ptyID: id,
      owner: { tabID: "cross-workspace", sessionID: session.data!.id },
    })
    expect(rebound.error).toBeUndefined()
    expect((await after.session.delete({ sessionID: session.data!.id })).error).toBeUndefined()
    expect((await before.pty.get({ ptyID: id })).response?.status).toBe(404)
  } finally {
    if (id) await before.pty.remove({ ptyID: id })
    await server.stop(true)
  }
})
