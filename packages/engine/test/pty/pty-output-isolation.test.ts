import { describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { Pty } from "@merakcode/engine/pty/index"
import { tmpdir } from "../fixture/fixture"
import { setTimeout as delay } from "node:timers/promises"

describe("pty", () => {
  test("does not leak output when websocket objects are reused", async () => {
    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const command = process.platform === "win32" ? "cmd.exe" : "cat"
        const a = await Pty.create({ command, title: "a" })
        const b = await Pty.create({ command, title: "b" })
        try {
          const outA: string[] = []
          const outB: string[] = []

          const ws = {
            readyState: 1,
            send: (data: unknown) => {
              outA.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
            },
            close: () => {
              // no-op (simulate abrupt drop)
            },
          }

          // Connect "a" first with ws.
          Pty.connect(a.id, ws as any)

          // Now "reuse" the same ws object for another connection.
          ws.send = (data: unknown) => {
            outB.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
          }
          Pty.connect(b.id, ws as any)

          // Clear connect metadata writes.
          outA.length = 0
          outB.length = 0

          // Output from a must never show up in b.
          Pty.write(a.id, "AAA\n")
          await delay(100)

          expect(outB.join("")).not.toContain("AAA")
        } finally {
          await Pty.remove(a.id)
          await Pty.remove(b.id)
        }
      },
    })
  })
})
