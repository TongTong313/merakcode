// deferTools must be listed in knownKeys in config.ts; otherwise the catchall moves it into options.
import { describe, expect, test } from "vitest"
import { Config } from "./config"

describe("Config.Agent deferTools", () => {
  test("parses as a string array", () => {
    const parsed = Config.Agent.parse({ deferTools: ["pdf_parse", "excel_parse"] })
    expect(parsed.deferTools).toEqual(["pdf_parse", "excel_parse"])
  })

  test("is undefined when unset and does not appear in options", () => {
    const parsed = Config.Agent.parse({ model: "anthropic/claude-test" })
    expect(parsed.deferTools).toBeUndefined()
    expect(parsed.options).toEqual({})
  })

  test("is not moved into options by the catchall", () => {
    const parsed = Config.Agent.parse({ deferTools: ["cron"] })
    expect(parsed.options?.deferTools).toBeUndefined()
  })

  test("keeps an empty array, which disables deferral (unlike undefined, which uses the default)", () => {
    const parsed = Config.Agent.parse({ deferTools: [] })
    expect(parsed.deferTools).toEqual([])
  })
})
