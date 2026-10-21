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

  // merak without a command only prints its help, so restarting it is no advice
  test("no hint tells the user to restart merak on its own", () => {
    for (const [name, spec] of entries) {
      expect(spec.hint.zh, name).not.toMatch(/重启 merak/)
      expect(spec.hint.en, name).not.toMatch(/restart merak/i)
    }
  })

  test("an error class name maps to at most one code", () => {
    const names = entries.flatMap(([, spec]) => spec.errors ?? [])
    expect(new Set(names).size).toBe(names.length)
  })
})

describe("ErrorCode.of", () => {
  test("maps known error names to their code", () => {
    expect(ErrorCode.of("ProviderModelNotFoundError")).toBe(ErrorCode.CATALOG.MODEL_NOT_FOUND.code)
    expect(ErrorCode.of("ConfigJsonError")).toBe(ErrorCode.CATALOG.CONFIG_JSON_INVALID.code)
  })

  test("provider API errors are classified by HTTP status", () => {
    expect(ErrorCode.of("APIError", { statusCode: 429 })).toBe(ErrorCode.CATALOG.RATE_LIMITED.code)
    expect(ErrorCode.of("APIError", { statusCode: 401 })).toBe(ErrorCode.CATALOG.PROVIDER_AUTH_FAILED.code)
    expect(ErrorCode.of("APIError", { statusCode: 503 })).toBe(ErrorCode.CATALOG.PROVIDER_REQUEST_FAILED.code)
  })

  test("unknown names fall back to the internal error code", () => {
    expect(ErrorCode.of("SomethingNobodyDeclared")).toBe(ErrorCode.CATALOG.INTERNAL.code)
  })

  test("spec looks a code up by its string", () => {
    expect(ErrorCode.spec("MRK-9000")?.title.en).toBe(ErrorCode.CATALOG.INTERNAL.title.en)
    expect(ErrorCode.spec("MRK-0000")).toBeUndefined()
  })
})
