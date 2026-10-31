// disableTools must be listed in knownKeys in config.ts; otherwise the catchall moves it into options.
import { describe, expect, test } from "vitest"
import { Config } from "./config"

describe("Config.Agent disableTools", () => {
  test("parses as a string array", () => {
    const parsed = Config.Agent.parse({ disableTools: ["pdf_parse", "excel_parse", "workflow_run"] })
    expect(parsed.disableTools).toEqual(["pdf_parse", "excel_parse", "workflow_run"])
  })

  test("is undefined when unset and does not appear in options", () => {
    const parsed = Config.Agent.parse({ model: "anthropic/claude-test" })
    expect(parsed.disableTools).toBeUndefined()
    expect(parsed.options).toEqual({})
  })

  test("is not moved into options by the catchall", () => {
    const parsed = Config.Agent.parse({ disableTools: ["cron"] })
    expect(parsed.options?.disableTools).toBeUndefined()
  })
})
