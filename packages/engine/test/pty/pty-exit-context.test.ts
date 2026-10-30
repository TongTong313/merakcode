import { expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Pty } from "@merakcode/engine/app/terminal/index"
import { tmpdir } from "../fixture/fixture"
import { setTimeout as delay } from "node:timers/promises"

// The exit callback comes from the native module, outside the request that created the terminal. It must still
// publish within the instance instead of throwing an uncaught error (which would take the engine down).
test("a terminal that exits after its request has finished does not throw outside the instance", async () => {
  await using dir = await tmpdir({ git: true })
  const errors: unknown[] = []
  const track = (error: unknown) => errors.push(error)
  process.on("uncaughtException", track)
  process.on("unhandledRejection", track)
  try {
    const [command, args] =
      process.platform === "win32" ? ["cmd.exe", ["/c", "ping -n 2 127.0.0.1 >nul"]] : ["sh", ["-c", "sleep 1"]]
    const info = await Instance.provide({
      directory: dir.path,
      fn: () => Pty.create({ command, args, title: "exits by itself" }),
    })
    await delay(3_000)
    expect(errors).toEqual([])
    expect(info.id).toBeTruthy()
  } finally {
    process.off("uncaughtException", track)
    process.off("unhandledRejection", track)
  }
}, 20_000)
