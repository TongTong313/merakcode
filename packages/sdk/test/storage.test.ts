import { spawn, execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { expect, test } from "vitest"
import { connect, ProtocolConnectionInfoSchema } from "../src/index"
import { SqliteStore } from "../src/store"

test("retains local and remote-host history across an engine process restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "merak-storage-"))
  const binary =
    process.env.MERAKCODE_TEST_BINARY ?? path.join(root, process.platform === "win32" ? "merak.exe" : "merak")
  try {
    if (!process.env.MERAKCODE_TEST_BINARY)
      await promisify(execFile)("go", ["build", "-o", binary, "./cmd/merak"], {
        cwd: path.resolve(import.meta.dirname, "../../../merak"),
      })
    for (const mode of ["local", "remote"]) {
      const home = await mkdtemp(path.join(root, `${mode}-`))
      const script = path.join(home, "replies.json")
      await writeFile(script, JSON.stringify([{ text: "Saved reply" }]))
      const start = async (storage: string) => {
        const child = spawn(binary, ["serve", "--script", script, "--store", storage], {
          env: { ...process.env, MERAKCODE_HOME: home },
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        })
        let diagnostic = ""
        child.stderr.on("data", (chunk: Buffer) => {
          diagnostic = (diagnostic + chunk.toString()).slice(-8192)
        })
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
        const stop = async () => {
          child.kill()
          await exited
        }
        try {
          for (let attempt = 0; attempt < 250; attempt++) {
            if (child.exitCode !== null)
              throw new Error(`Engine exited with ${child.exitCode} (${mode} -> ${storage}): ${diagnostic}`)
            const info = await readFile(path.join(home, "engine.json"), "utf8")
              .then((text) => ProtocolConnectionInfoSchema.parse(JSON.parse(text)))
              .catch(() => undefined)
            if (info && info.pid === child.pid) return { info, stop }
            await delay(20)
          }
          throw new Error("Engine did not publish connection information")
        } catch (error) {
          await stop()
          throw error
        }
      }
      const first = await start(mode)
      const store = mode === "remote" ? new SqliteStore(path.join(home, "merak.db")) : undefined
      let id: string
      try {
        const client = await connect({ ...first.info, store })
        try {
          expect(client.hello.store).toBe(mode === "remote" ? "accepted" : undefined)
          id = (await client.session.create({ provider: "fake" })).session
          const done = Promise.withResolvers<void>()
          await client.events.subscribe({ scope: { session: id } }, (event) => {
            if (event.type === "turn.finished") done.resolve()
          })
          await client.session.send({ session: id, parts: [{ text: "Remember this" }] })
          await Promise.race([
            done.promise,
            delay(5000).then(() => {
              throw new Error("Turn timed out")
            }),
          ])
          const facts = await client.events.read({ stream: `session:${id}`, from: 1, limit: 100 })
          expect(facts?.map((event) => event.seq)).toEqual(facts?.map((_, index) => index + 1))
          expect(facts?.filter((event) => event.type === "session.mcp_configured")).toHaveLength(1)
          expect(facts?.filter((event) => event.type === "turn.finished")).toHaveLength(1)
          if (store) expect(store.read(`session:${id}`, 1, 100)).toEqual(facts)
        } finally {
          await client.close()
        }
      } finally {
        await first.stop()
        store?.close()
      }
      const second = await start("local")
      try {
        const client = await connect(second.info)
        try {
          expect((await client.session.list())?.map((session) => session.id)).toEqual([id])
          const facts = await client.events.read({ stream: `session:${id}`, from: 1, limit: 100 })
          expect(facts?.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
          expect(facts?.find((event) => event.type === "message.completed")?.payload).toMatchObject({
            role: "assistant",
            parts: [{ text: "Saved reply" }],
          })
          const done = Promise.withResolvers<void>()
          await client.events.subscribe({ scope: { session: id } }, (event) => {
            if (event.type === "turn.finished") done.resolve()
          })
          await client.session.send({ session: id, parts: [{ text: "Continue" }] })
          await Promise.race([
            done.promise,
            delay(5000).then(() => {
              throw new Error("Restored turn timed out")
            }),
          ])
          expect(
            (await client.events.read({ stream: `session:${id}`, from: 8, limit: 100 }))?.map((event) => event.seq),
          ).toEqual([8, 9, 10, 11, 12])
        } finally {
          await client.close()
        }
      } finally {
        await second.stop()
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
