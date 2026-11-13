import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test, expect, type Kit } from "./fixture"
import { buildFakeService, failing, runsOf } from "./fake-service"

/** The real login item of the person running the tests: the page must never write it */
function realLoginItem() {
  if (process.platform === "win32") {
    try {
      return execFileSync(
        path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe"),
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "MerakCode"],
        { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      )
    } catch {
      return "absent"
    }
  }
  const file =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "LaunchAgents", "com.merakcode.merak.plist")
      : path.join(
          process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
          "systemd",
          "user",
          "merakcode.service",
        )
  try {
    return readFileSync(file, "utf8")
  } catch {
    return "absent"
  }
}

let directory: string
let program: string
let before: string
let previous: string | undefined
test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "merakcode-login-e2e-"))
  program = await buildFakeService(directory)
  before = realLoginItem()
  previous = process.env.MERAKCODE_SERVICE_PROGRAM
  // The unpackaged app runs this program for `service install` and `service uninstall` instead of the engine
  process.env.MERAKCODE_SERVICE_PROGRAM = program
})
test.afterAll(async () => {
  if (previous === undefined) delete process.env.MERAKCODE_SERVICE_PROGRAM
  else process.env.MERAKCODE_SERVICE_PROGRAM = previous
  await rm(directory, { recursive: true, force: true })
})

const login = (kit: Kit) =>
  kit.page.getByRole("region", { name: "后台引擎", exact: true }).getByRole("switch", { name: "登录时启动" })

test("the start-at-login switch is off by default, installs and removes the login item through the engine program, and survives a restart", async ({
  kit,
}) => {
  await kit.settings(/^后台引擎$/)
  await expect(login(kit)).not.toBeChecked()
  expect(await runsOf(program)).toEqual([])

  await login(kit).click()
  await expect(login(kit)).toBeChecked()
  expect(await runsOf(program)).toEqual(["service install"])
  const stored = async () =>
    JSON.parse(await readFile(path.join(kit.root, "electron", "storage", "desktop.main.json"), "utf8")) as Record<
      string,
      string
    >
  expect(JSON.parse((await stored()).loginProgram!)).toBe(program)

  // A start with the same engine path registers nothing again
  await kit.restart()
  await kit.settings(/^后台引擎$/)
  await expect(login(kit)).toBeChecked()
  expect(await runsOf(program)).toEqual(["service install"])

  await login(kit).click()
  await expect(login(kit)).not.toBeChecked()
  expect(await runsOf(program)).toEqual(["service install", "service uninstall"])
  expect(await stored()).not.toHaveProperty("loginProgram")

  expect(realLoginItem()).toBe(before)
})

test("when the system refuses, the switch stays off and the error is shown", async ({ kit }) => {
  await failing(program)
  await kit.settings(/^后台引擎$/)
  await login(kit).click()
  await expect(kit.page.getByText("没能设置登录时启动")).toBeVisible()
  await expect(kit.page.getByText("MRK-5014")).toBeVisible()
  await expect(login(kit)).not.toBeChecked()
  expect(realLoginItem()).toBe(before)
})
