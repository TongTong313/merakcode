import { expect, test } from "vitest"
import path from "node:path"
import { chmod } from "node:fs/promises"
import { Filesystem } from "@merakcode/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import { checkCli } from "../../script/smoke-npm-command"

async function consumer(directory: string, command?: string) {
  const root = path.join(directory, "consumer with spaces")
  await Filesystem.write(path.join(root, "node_modules/merakcode/bin/merak"), 'process.stdout.write("1.2.0\\n")')
  if (command) {
    const entry = path.join(root, "node_modules/.bin", process.platform === "win32" ? "merak.cmd" : "merak")
    await Filesystem.write(
      entry,
      process.platform === "win32" ? `@echo off\r\n${command}\r\n` : `#!/bin/sh\n${command}\n`,
    )
    await chmod(entry, 0o755)
  }
  return root
}

test("a runnable launcher does not replace the installed npm command entry", async () => {
  await using tmp = await tmpdir()
  await expect(checkCli(await consumer(tmp.path), "1.2.0")).rejects.toThrow(/merak/)
})

test("the installed command and launcher both report the package version from a path with spaces", async () => {
  await using tmp = await tmpdir()
  await expect(checkCli(await consumer(tmp.path, "echo 1.2.0"), "1.2.0")).resolves.toBeUndefined()
})

test.each(["echo 0.0.0", "exit 7"])("an invalid installed command fails the smoke check: %s", async (command) => {
  await using tmp = await tmpdir()
  await expect(checkCli(await consumer(tmp.path, command), "1.2.0")).rejects.toThrow()
})
