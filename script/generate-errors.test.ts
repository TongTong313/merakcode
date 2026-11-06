import { describe, expect, test } from "vitest"
import { ErrorCode } from "@merakcode/util/error-code"
import { render } from "./generate-errors"

describe("docs/errors.md", () => {
  const text = render()

  test("lists every code with its Chinese and English title", () => {
    for (const spec of Object.values(ErrorCode.CATALOG as Record<string, ErrorCode.Spec>)) {
      expect(text).toContain(`| ${spec.code} |`)
      expect(text).toContain(spec.title.zh)
      expect(text).toContain(spec.title.en)
    }
  })

  test("lists codes in numeric order", () => {
    expect(text.indexOf("MRK-8001")).toBeLessThan(text.indexOf("MRK-8002"))
    expect(text.indexOf("MRK-8002")).toBeLessThan(text.indexOf("MRK-8004"))
  })

  test("says it is generated, so nobody edits it by hand", () => {
    expect(text).toContain("pnpm generate:errors")
  })
})
