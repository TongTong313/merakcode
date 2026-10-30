import { describe, expect, test } from "vitest"
import EXIT_DESCRIPTION from "./plan-exit.txt"

describe("plan-exit tool description", () => {
  // The description tells the model when to call the tool. It must cover common Chinese and English phrases for asking
  // to execute, otherwise a request to start executing is easily taken as editing code directly.
  test("asks to be called when the user wants to execute, with Chinese and English trigger phrases", () => {
    expect(EXIT_DESCRIPTION).toContain("plan_exit")
    expect(EXIT_DESCRIPTION).toMatch(/开始执行/)
    expect(EXIT_DESCRIPTION).toMatch(/开始实施/)
    expect(EXIT_DESCRIPTION).toMatch(/execute the plan/i)
    expect(EXIT_DESCRIPTION).toMatch(/start implementing/i)
    expect(EXIT_DESCRIPTION).toMatch(/Do NOT edit project files|MUST NOT edit project files/i)
  })
})
