import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configSyntaxError, peekGlobalConfig, readConfigFile } from "./config-peek"

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "config-peek-"))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("peekGlobalConfig", () => {
  test("returns nothing when the file does not exist", () => {
    expect(peekGlobalConfig(join(dir, "missing.jsonc"))).toEqual({})
  })

  test("reads only the locale, from JSONC with comments and trailing commas", async () => {
    const file = join(dir, "ok.jsonc")
    await writeFile(file, '{\n  // UI language\n  "locale": "en-US",\n  "model": "a/b",\n}\n')
    expect(peekGlobalConfig(file)).toEqual({ locale: "en-US" })
  })

  test("drops a locale of the wrong type and survives a broken file", async () => {
    const wrong = join(dir, "wrong.json")
    await writeFile(wrong, '{ "locale": 3 }')
    expect(peekGlobalConfig(wrong)).toEqual({})
    const broken = join(dir, "broken.json")
    await writeFile(broken, "{ not json")
    expect(peekGlobalConfig(broken)).toEqual({})
  })
})

describe("readConfigFile", () => {
  test("parses JSONC; a broken file gives its text so a bug report still shows it", async () => {
    const file = join(dir, "read.jsonc")
    await writeFile(file, '{ // c\n "model": "a/b", }')
    expect(readConfigFile(file)).toEqual({ model: "a/b" })
    const broken = join(dir, "read-broken.json")
    await writeFile(broken, '{ "model": ')
    expect(readConfigFile(broken)).toBe('{ "model": ')
    expect(readConfigFile(join(dir, "none.json"))).toBeUndefined()
  })
})

describe("configSyntaxError", () => {
  test("gives the line of the first syntax error", async () => {
    const file = join(dir, "syntax.json")
    await writeFile(file, '{\n  "locale": "en-US",\n  "model": \n')
    expect(configSyntaxError(file)).toEqual({ line: 4 })
  })

  test("accepts JSONC comments and trailing commas, and a missing file", async () => {
    const file = join(dir, "fine.jsonc")
    await writeFile(file, '{\n  // comment\n  "locale": "en-US",\n}\n')
    expect(configSyntaxError(file)).toBeUndefined()
    expect(configSyntaxError(join(dir, "missing.json"))).toBeUndefined()
  })
})
