import { afterEach, expect, test } from "vitest"
import os from "node:os"
import path from "node:path"
import { Installation } from "../../src/cli/installation"

const saved = process.env.MERAKCODE_INSTALL_DIR
afterEach(() => {
  if (saved === undefined) delete process.env.MERAKCODE_INSTALL_DIR
  else process.env.MERAKCODE_INSTALL_DIR = saved
})

// Decided by where the running code lives: the command found on PATH is not necessarily the copy that is running
test("the install method follows where the running code is installed", () => {
  const home = path.join(os.tmpdir(), "merakcode-home")
  process.env.MERAKCODE_INSTALL_DIR = home
  expect(Installation.method(path.join(home, "versions", "0.1.0", "lib"))).toBe("release")
  const npm = path.join(os.tmpdir(), "prefix", "node_modules", "merakcode-linux-x64", "lib")
  expect(Installation.method(npm)).toBe("npm")
  expect(Installation.method(path.join(os.tmpdir(), "merakcode", "packages", "engine", "src", "installation"))).toBe(
    "unknown",
  )
})
