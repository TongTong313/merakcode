import { afterEach, describe, expect, test } from "vitest"
import { Flag } from "./flag"

/**
 * Covers only the access-time getters and `Flag.read`: constants evaluated at module load cannot re-read the
 * environment in the same process, but they share the same env() implementation and follow the same rules.
 */
const KEYS = [
  "MERAKCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_CONTENT",
  "MERAKCODE_PERMISSION",
  "OPENCODE_PERMISSION",
  "MERAKCODE_NONINTERACTIVE",
  "OPENCODE_NONINTERACTIVE",
  "MERAKCODE_TEST_PROBE",
  "OPENCODE_TEST_PROBE",
  "MERAKCODE_SERVER_PARENT_PID",
]

const saved = new Map<string, string | undefined>()
for (const key of KEYS) saved.set(key, process.env[key])

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("Flag reads only MERAKCODE_* environment variables", () => {
  test("reads the product environment variable", () => {
    process.env["MERAKCODE_CONFIG_CONTENT"] = '{"model":"a/b"}'
    expect(Flag.MERAKCODE_CONFIG_CONTENT).toBe('{"model":"a/b"}')
  })

  test("ignores the OPENCODE_ variable of the same name", () => {
    delete process.env["MERAKCODE_CONFIG_CONTENT"]
    process.env["OPENCODE_CONFIG_CONTENT"] = '{"model":"a/b"}'
    expect(Flag.MERAKCODE_CONFIG_CONTENT).toBeUndefined()

    delete process.env["MERAKCODE_NONINTERACTIVE"]
    process.env["OPENCODE_NONINTERACTIVE"] = "1"
    expect(Flag.MERAKCODE_NONINTERACTIVE).toBe(false)

    delete process.env["MERAKCODE_TEST_PROBE"]
    process.env["OPENCODE_TEST_PROBE"] = "x"
    expect(Flag.read("TEST_PROBE")).toBeUndefined()
  })

  test("treats an empty product variable as unset", () => {
    // This is env()'s own rule, unrelated to aliases: an empty string does not count as explicitly set
    process.env["MERAKCODE_TEST_PROBE"] = ""
    expect(Flag.read("TEST_PROBE")).toBeUndefined()
  })

  test("MERAKCODE_NONINTERACTIVE is read at access time and only 1/true count as on", () => {
    for (const [value, expected] of [
      [undefined, false],
      ["1", true],
      ["false", false],
      ["true", true],
    ] as const) {
      if (value === undefined) delete process.env.MERAKCODE_NONINTERACTIVE
      else process.env.MERAKCODE_NONINTERACTIVE = value
      expect(Flag.MERAKCODE_NONINTERACTIVE, String(value)).toBe(expected)
    }
  })

  test("returns undefined when unset and false for boolean switches", () => {
    delete process.env["MERAKCODE_NONINTERACTIVE"]
    expect(Flag.MERAKCODE_NONINTERACTIVE).toBe(false)
    delete process.env["MERAKCODE_TEST_PROBE"]
    expect(Flag.read("TEST_PROBE")).toBeUndefined()
  })
})

describe("Flag.seal", () => {
  afterEach(() => Flag.unsealForTest())

  test("moves engine-only variables out of process.env but keeps them readable through Flag", () => {
    process.env["MERAKCODE_CONFIG_CONTENT"] = '{"model":"a/b"}'
    process.env["MERAKCODE_SERVER_PARENT_PID"] = "4242"
    Flag.seal()
    expect(process.env["MERAKCODE_CONFIG_CONTENT"]).toBeUndefined()
    expect(process.env["MERAKCODE_SERVER_PARENT_PID"]).toBeUndefined()
    expect(Flag.MERAKCODE_CONFIG_CONTENT).toBe('{"model":"a/b"}')
    expect(Flag.MERAKCODE_SERVER_PARENT_PID).toBe(4242)
  })
})
