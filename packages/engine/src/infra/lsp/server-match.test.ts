import { describe, expect, test } from "vitest"
import { serverHandlesExt } from "./server-match"

describe("serverHandlesExt", () => {
  test("empty extensions handle any extension", () => {
    expect(serverHandlesExt({ extensions: [] }, ".js")).toBe(true)
  })

  test("returns true when extensions include the extension", () => {
    expect(serverHandlesExt({ extensions: [".ts", ".js"] }, ".js")).toBe(true)
  })

  test("returns false when extensions do not include the extension", () => {
    expect(serverHandlesExt({ extensions: [".ts", ".tsx"] }, ".js")).toBe(false)
  })
})
