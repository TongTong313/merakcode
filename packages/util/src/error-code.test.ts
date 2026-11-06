import { describe, expect, test } from "vitest"
import { ErrorCode } from "./error-code"

const entries = Object.entries(ErrorCode.CATALOG as Record<string, ErrorCode.Spec>)

describe("ErrorCode catalog", () => {
  test("codes are unique and look like MRK-dddd", () => {
    const codes = entries.map(([, spec]) => spec.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) expect(code).toMatch(/^MRK-\d{4}$/)
  })

  test("each code sits in the thousand range of its domain", () => {
    const range = {
      engine: 1,
      provider: 2,
      config: 3,
      session: 4,
      tool: 5,
      extension: 6,
      workspace: 7,
      update: 8,
      internal: 9,
    }
    for (const [name, spec] of entries) expect(Number(spec.code.slice(4, 5)), name).toBe(range[spec.domain])
  })

  test("every entry says what happened and what to do, in Chinese and English, with an HTTP error status", () => {
    for (const [name, spec] of entries) {
      expect(spec.title.zh.trim(), name).not.toBe("")
      expect(spec.title.en.trim(), name).not.toBe("")
      expect(spec.hint.zh.trim(), name).not.toBe("")
      expect(spec.hint.en.trim(), name).not.toBe("")
      expect(spec.status, name).toBeGreaterThanOrEqual(400)
      expect(spec.status, name).toBeLessThan(600)
    }
  })
})
