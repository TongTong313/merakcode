import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import { buildFakeService, failing, runsOf } from "../e2e/fake-service"
import { Login } from "../src/login"
import { Settings } from "../src/settings"
import { Storage } from "../src/storage"

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "merakcode-login-"))
}, 60_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A fresh app data directory and a fake engine program in it */
async function setup() {
  const directory = await mkdtemp(path.join(root, "case-"))
  const program = await buildFakeService(path.join(directory, "engine"))
  const settings = new Settings(new Storage(path.join(directory, "storage")))
  const warnings: string[] = []
  let current = program
  const login = new Login({ settings, program: () => current, log: (message) => warnings.push(message) })
  return { directory, program, settings, login, warnings, move: (to: string) => (current = to) }
}

test("is off by default and records nothing", async () => {
  const { login, settings, program } = await setup()
  expect(login.enabled).toBe(false)
  expect(settings.loginProgram).toBeUndefined()
  expect(await runsOf(program)).toEqual([])
})

test("turning it on runs service install with the engine and records its path; turning it off uninstalls and records nothing", async () => {
  const { login, settings, program, directory } = await setup()
  await login.set(true)
  expect(await runsOf(program)).toEqual(["service install"])
  expect(login.enabled).toBe(true)
  expect(new Settings(new Storage(path.join(directory, "storage"))).loginProgram).toBe(program)
  await login.set(false)
  expect(await runsOf(program)).toEqual(["service install", "service uninstall"])
  expect(login.enabled).toBe(false)
  expect(settings.loginProgram).toBeUndefined()
  expect(new Settings(new Storage(path.join(directory, "storage"))).loginProgram).toBeUndefined()
})

test("a failed install keeps the switch off and reports the engine's error code; a failed uninstall keeps it on", async () => {
  const { login, program } = await setup()
  await failing(program)
  await expect(login.set(true)).rejects.toThrow("MRK-5014")
  expect(login.enabled).toBe(false)
  const second = await setup()
  await second.login.set(true)
  await failing(second.program)
  await expect(second.login.set(false)).rejects.toThrow("MRK-5014")
  expect(second.login.enabled).toBe(true)
})

test("a program that cannot run is reported with the install or uninstall code", async () => {
  const { directory, settings } = await setup()
  const missing = path.join(directory, "gone", "merak")
  const login = new Login({ settings, program: () => missing, log: () => {} })
  await expect(login.set(true)).rejects.toThrow("MRK-5014")
  await expect(login.set(false)).rejects.toThrow("MRK-5015")
})

test("at app start nothing runs while it is off, or while the recorded path is still the engine's", async () => {
  const { login, program } = await setup()
  await login.sync()
  expect(await runsOf(program)).toEqual([])
  await login.set(true)
  await login.sync()
  expect(await runsOf(program)).toEqual(["service install"])
})

test("at app start a moved engine installs the login item again and records the new path", async () => {
  const { login, settings, program, directory, move } = await setup()
  await login.set(true)
  const updated = path.join(directory, "engine-2.0", path.basename(program))
  await buildFakeService(path.dirname(updated))
  move(updated)
  await login.sync()
  expect(await runsOf(updated)).toEqual(["service install"])
  expect(settings.loginProgram).toBe(updated)
  expect(login.enabled).toBe(true)
})

test("a failed re-install at app start is logged and keeps the old record for the next start", async () => {
  const { login, settings, program, warnings, move, directory } = await setup()
  await login.set(true)
  const updated = path.join(directory, "engine-3.0", path.basename(program))
  await buildFakeService(path.dirname(updated))
  await failing(updated)
  move(updated)
  await login.sync()
  expect(warnings).toEqual(["login item not updated"])
  expect(settings.loginProgram).toBe(program)
})

test("calls made at once run one after another", async () => {
  const { login, program } = await setup()
  await Promise.all([login.set(true), login.set(false), login.set(true)])
  expect(await runsOf(program)).toEqual(["service install", "service uninstall", "service install"])
  expect(login.enabled).toBe(true)
})
