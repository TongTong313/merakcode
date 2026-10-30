import { describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { tmpdir } from "../fixture/fixture"

describe("Loop.cancelTool", () => {
  test("returns false for unknown sessionID", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(Loop.cancelTool("ses_does_not_exist", "call_x")).toBe(false)
      },
    })
  })

  test("returns false for unknown callID on a never-started session id", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // No Loop.state() entry for this sessionID (the loop never started), so it returns false.
        expect(Loop.cancelTool("ses_01HX0000000000000000000000", "call_unknown")).toBe(false)
      },
    })
  })
})
