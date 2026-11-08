import { execFile, spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { expect, test } from "vitest"
import { connect, connectTerminal } from "../src/index"

test.each([false, true])(
  "preserves queued terminal input and onOpen ordering: %s",
  async (sendOnOpen) => {
    const home = await mkdtemp(path.join(tmpdir(), "merak-terminal-sdk-"))
    const binary =
      process.env.MERAKCODE_TEST_BINARY ?? path.join(home, process.platform === "win32" ? "merak.exe" : "merak")
    if (!process.env.MERAKCODE_TEST_BINARY)
      await promisify(execFile)("go", ["build", "-o", binary, "./cmd/merak"], {
        cwd: path.resolve(import.meta.dirname, "../../../merak"),
        windowsHide: true,
      })
    const script = path.join(home, "replies.json")
    await writeFile(script, JSON.stringify([{ text: "Ready" }]))
    const child = spawn(binary, ["serve", "--script", script], {
      cwd: home,
      env: { ...process.env, MERAKCODE_HOME: home },
      stdio: "ignore",
      windowsHide: true,
    })
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    try {
      let info: { endpoint: string; token: string } | undefined
      for (let attempt = 0; attempt < 250; attempt++) {
        info = await readFile(path.join(home, "engine.json"), "utf8").then(
          (body) => JSON.parse(body),
          () => undefined,
        )
        if (info) break
        if (child.exitCode !== null) throw new Error("Engine exited before publishing its endpoint")
        await delay(20)
      }
      if (!info) throw new Error("No engine endpoint")
      const client = await connect(info)
      try {
        const term = await client.terminal.create({
          directory: home,
          command: process.platform === "win32" ? process.env.COMSPEC! : "/bin/sh",
          args: process.platform === "win32" ? ["/Q"] : [],
          size: { cols: 120, rows: 30 },
        })
        let output = ""
        const decoder = new TextDecoder()
        const socket = connectTerminal({
          ...info,
          id: term.id,
          onData: (body) => {
            output += decoder.decode(body, { stream: true })
          },
          onOpen: () => {
            if (sendOnOpen) socket.send("echo LATE-THREE\r\n")
          },
        })
        socket.send("echo EARLY-ONE\r\n")
        socket.send("echo EARLY-TWO\r\n")
        try {
          await expect.poll(() => output, { timeout: 10000 }).toContain(sendOnOpen ? "LATE-THREE" : "EARLY-TWO")
          expect(output.indexOf("EARLY-ONE")).toBeLessThan(output.indexOf("EARLY-TWO"))
          if (sendOnOpen) expect(output.indexOf("EARLY-TWO")).toBeLessThan(output.indexOf("LATE-THREE"))
          await expect.poll(() => socket.cursor).toBeGreaterThan(0)
        } finally {
          socket.close()
          await socket.closed
        }
        let replay = ""
        const restored = connectTerminal({
          ...info,
          id: term.id,
          cursor: 0,
          onData: (body) => {
            replay += new TextDecoder().decode(body)
          },
        })
        try {
          await expect.poll(() => replay, { timeout: 5000 }).toContain("EARLY-TWO")
        } finally {
          restored.close()
          await restored.closed
        }
        await client.terminal.remove({ id: term.id })
        expect(await client.terminal.list({ directory: home })).toEqual([])
      } finally {
        await client.close()
      }
    } finally {
      child.kill()
      await exited
      await rm(home, { recursive: true, force: true })
    }
  },
  30000,
)
