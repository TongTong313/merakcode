/**
 * SDK public API snapshot (pnpm check:api): the names and signatures exported by each public entry.
 * Types generated from openapi.json are not listed (their changes show up in openapi.json), only marked as generated.
 */
import { expect, test } from "vitest"
import { snapshot } from "../script/api"

const text = snapshot()

test("lists hand-written exports and signatures per entry", () => {
  expect(text).toContain("## @merakcode/sdk\n")
  expect(text).toMatch(/^function createMerakCode\(options\?: MerakCodeOptions\): Promise<MerakCode>$/m)
  expect(text).toContain("## @merakcode/sdk/process\n")
  expect(text).toMatch(/^function startEngine\(options\?: EngineOptions\): Promise<Engine>$/m)
  expect(text).toContain(
    "class EngineExitedError extends MerakCodeError { constructor(readonly exitCode: number | null); }",
  )
  expect(text).toContain("## @merakcode/sdk/errors\n")
  expect(text).toContain("## @merakcode/sdk/plugin\n")
  expect(text).toMatch(/^function tool</m)
})

test("counts generated types without listing them", () => {
  const client = text.slice(text.indexOf("## @merakcode/sdk/client\n"))
  expect(client).toMatch(/^\+ \d+ exports generated from openapi\.json$/m)
  expect(client).not.toMatch(/^type SessionStats\b/m)
  expect(client).toMatch(/^function createMerakCodeClient\(/m)
})
