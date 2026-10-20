import { describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { tmpdir } from "../fixture/fixture"

describe("SessionRunner.cancelTool", () => {
  test("returns false for unknown sessionID", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(SessionRunner.cancelTool("ses_does_not_exist", "call_x")).toBe(false)
      },
    })
  })

  test("returns false for unknown callID on a never-started session id", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // No SessionRunner.state() entry for this sessionID (the loop never started), so it returns false.
        expect(SessionRunner.cancelTool("ses_01HX0000000000000000000000", "call_unknown")).toBe(false)
      },
    })
  })
})
