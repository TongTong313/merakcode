import { describe, expect, test } from "vitest"
import { ChildEnv } from "./child-env"

describe("ChildEnv.build", () => {
  test("drops the engine's own secrets and internal settings", () => {
    const env = ChildEnv.build({
      base: {
        PATH: "/usr/bin",
        MERAKCODE_SERVER_PASSWORD: "secret",
        MERAKCODE_SERVER_USERNAME: "merakcode",
        MERAKCODE_SERVER_PARENT_PID: "42",
        MERAKCODE_CONFIG_CONTENT: '{"provider":{}}',
      },
    })
    expect(env).toEqual({ PATH: "/usr/bin" })
  })

  test("extra values override the base, and undefined values are dropped", () => {
    const env = ChildEnv.build({ base: { A: "1", B: "2", C: undefined }, extra: { B: "3", D: undefined } })
    expect(env).toEqual({ A: "1", B: "3" })
  })

  test("extra values cannot bring a blocked variable back", () => {
    expect(ChildEnv.build({ base: {}, extra: { MERAKCODE_SERVER_PASSWORD: "x" } })).toEqual({})
  })
})
