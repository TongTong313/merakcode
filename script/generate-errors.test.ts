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

  test("groups codes by domain in numeric order", () => {
    expect(text.indexOf("MRK-1001")).toBeLessThan(text.indexOf("MRK-2001"))
    expect(text.indexOf("MRK-2001")).toBeLessThan(text.indexOf("MRK-9000"))
  })

  test("says it is generated, so nobody edits it by hand", () => {
    expect(text).toContain("pnpm generate:errors")
  })
})
