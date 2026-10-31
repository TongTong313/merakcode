import { Config } from "@merakcode/engine/app/config/files/config"
import { expect, test } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { globalConfigFile } from "@merakcode/util/paths"
import { Filesystem } from "@merakcode/util/filesystem"
import { ConfigEdit } from "../../src/infra/config/edit"

test.skipIf(process.platform !== "win32")(
  "a temporary Windows reader does not lose an atomic config edit",
  async () => {
    await Config.edit("global", (text) => ConfigEdit.set(text, ["model"], "before"))
    const file = globalConfigFile()
    const powershell = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    )
    const reader = spawn(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$file = [IO.File]::Open($env:MERAKCODE_LOCK_TEST_FILE, 'Open', 'Read', 'ReadWrite'); [Console]::Out.WriteLine('ready'); [Console]::In.ReadLine() | Out-Null; $file.Dispose()",
      ],
      { env: { ...process.env, MERAKCODE_LOCK_TEST_FILE: file }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    )
    const exited = once(reader, "exit")
    try {
      const ready = once(reader.stdout, "data").then(([data]) => data.toString().trim())
      const stopped = exited.then(() => {
        throw new Error("The Windows reader exited before acquiring the file lock")
      })
      expect(await Promise.race([ready, stopped])).toBe("ready")
      const writing = Config.edit("global", (text) => ConfigEdit.set(text, ["model"], "after")).then(
        () => undefined,
        (error: unknown) => error,
      )
      await expect
        .poll(async () => (await readdir(path.dirname(file))).some((name) => name.endsWith(".tmp")), { interval: 10 })
        .toBe(true)
      expect(await Filesystem.readJson(file)).toMatchObject({ model: "before" })
      await Filesystem.write(file, JSON.stringify({ model: "before", small_model: "external/model" }))
      reader.stdin.end("\n")
      await exited
      expect(await writing).toBeUndefined()
      expect(await Filesystem.readJson(file)).toMatchObject({ model: "after", small_model: "external/model" })
    } finally {
      if (!reader.stdin.writableEnded) reader.stdin.end("\n")
      await exited
    }
  },
)
