import { expect, test } from "vitest"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { connectPty, createMerakCodeClient } from "@merakcode/sdk/client"
import { Server } from "../../src/app/server/server"
import { tmpdir } from "../fixture/fixture"

for (const system of [false, true])
  test.runIf(process.platform === "win32")(
    system
      ? "Windows PowerShell preserves Unicode input across repeated terminal resizes"
      : "the default Windows terminal uses PowerShell and preserves Unicode input across repeated resizes",
    async () => {
      await using root = await tmpdir()
      const marker = path.join(root.path, "received.txt")
      const script = path.join(root.path, "输入任务.mjs")
      await writeFile(
        script,
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},process.argv[2]);console.log('complete-'+process.argv[2])`,
      )
      const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path, throwOnError: true })
      let ptyID: string | undefined
      let connection: ReturnType<typeof connectPty> | undefined
      let output = ""
      try {
        const { data: pty } = await client.pty.create({
          ...(system
            ? { command: path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe") }
            : {}),
          size: { cols: 80, rows: 24 },
        })
        if (!pty) throw new Error("Expected a created terminal")
        ptyID = pty.id
        expect(path.basename(pty.command).toLowerCase()).toMatch(/^(pwsh|powershell)(\.exe)?$/)
        connection = connectPty({
          baseUrl: server.url,
          ptyID,
          directory: root.path,
          onData(data) {
            if (typeof data !== "string") return
            output += data
            if (data.includes("\x1b[6n")) connection?.send("\x1b[1;1R")
            if (data.includes("\x1b[c")) connection?.send("\x1b[?1;2c")
          },
        })
        await expect.poll(() => /PS [\s\S]*>/.test(output), { timeout: 15_000 }).toBe(true)
        for (let round = 0; round < 20; round++) {
          output = ""
          await client.pty.update({ ptyID, size: round % 2 ? { cols: 80, rows: 24 } : { cols: 65, rows: 56 } })
          for (const character of `node "${script}" ${round}\r`) connection.send(character)
          await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 5_000 }).toBe(String(round))
          await expect
            .poll(() => {
              const completed = output.indexOf(`complete-${round}`)
              return completed >= 0 && /PS [\s\S]*>/.test(output.slice(completed))
            })
            .toBe(true)
        }
      } catch (error) {
        throw new Error(`Terminal output: ${JSON.stringify(output)}`, { cause: error })
      } finally {
        connection?.close()
        try {
          if (ptyID) await client.pty.remove({ ptyID })
        } finally {
          await server.stop(true)
        }
      }
    },
    60_000,
  )
