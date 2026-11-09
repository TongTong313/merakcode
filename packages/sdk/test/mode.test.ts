import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { connect, watchConversation, type Conversation } from "../src/index"

it("selects takeover through the SDK and writes without an approval client", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "merakcode-sdk-mode-"))
  const binary =
    process.env.MERAKCODE_TEST_BINARY ?? path.join(home, process.platform === "win32" ? "merak.exe" : "merak")
  try {
    if (!process.env.MERAKCODE_TEST_BINARY)
      await promisify(execFile)("go", ["build", "-o", binary, "./cmd/merak"], {
        cwd: path.resolve(import.meta.dirname, "../../../merak"),
        windowsHide: true,
      })
    const script = path.join(home, "replies.json")
    await writeFile(
      script,
      JSON.stringify([
        { calls: [{ id: "write", name: "write_file", input: { path: "mode.txt", content: "SDK takeover" } }] },
        { text: "Finished" },
      ]),
    )
    const child = spawn(binary, ["serve", "--script", script], {
      env: { ...process.env, MERAKCODE_HOME: home },
      stdio: "ignore",
      windowsHide: true,
    })
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    try {
      let info: { endpoint: string; token: string } | undefined
      for (let attempt = 0; attempt < 250; attempt++) {
        if (child.exitCode !== null) throw new Error(`Engine exited with ${child.exitCode}`)
        info = await readFile(path.join(home, "engine.json"), "utf8")
          .then((body) => JSON.parse(body) as { endpoint: string; token: string })
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
            return undefined
          })
        if (info) break
        await delay(20)
      }
      if (!info) throw new Error("Engine did not publish connection information")
      const client = await connect(info)
      try {
        const status = await client.sandbox.status({ workdir: home, mode: "takeover" })
        expect(status).toMatchObject({ disabled: true, available: false, backend: "none", network: "none" })
        await mkdir(path.join(home, ".git", "hooks"), { recursive: true })
        const enabled = await client.sandbox.status({ workdir: home, mode: "ask" })
        const enforced = enabled.available && (process.platform === "win32" || process.platform === "darwin")
        expect(enabled.protect).toEqual([
          { path: path.join(home, ".git", "hooks"), state: enforced ? "enforced" : "unenforced" },
          ...[".git/config", "merakcode.json", "merakcode.jsonc", ".merakcode"].map((name) => ({
            path: path.join(home, name),
            state: "missing",
          })),
        ])
        for (const name of [".git/config", "merakcode.json", "merakcode.jsonc", ".merakcode"])
          await expect(readFile(path.join(home, name))).rejects.toMatchObject({ code: "ENOENT" })
        const created = await client.session.create({ provider: "fake", workdir: home, mode: "takeover" })
        let view: Conversation | undefined
        const watching = await watchConversation(client, created.session, (value) => {
          view = value
        })
        try {
          expect(view?.state.config.mode).toBe("takeover")
          await client.session.send({ session: created.session, parts: [{ text: "Write the file" }] })
          await expect.poll(() => view?.state.status).toBe("done")
          expect(await readFile(path.join(home, "mode.txt"), "utf8")).toBe("SDK takeover")
        } finally {
          await watching.close()
        }
      } finally {
        await client.close()
      }
    } finally {
      child.kill()
      await exited
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 60000)
