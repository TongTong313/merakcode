import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homeRouteIfSessionNotFound, isSessionNotFoundError } from "../../src/cli/cmd/tui/util/session-not-found"

describe("isSessionNotFoundError", () => {
  test("matches hey-api NotFoundError bodies and HTTP 404", () => {
    expect(isSessionNotFoundError({ name: "NotFoundError", data: { message: "gone" } })).toBe(true)
    expect(isSessionNotFoundError({ status: 404 })).toBe(true)
    expect(isSessionNotFoundError({ error: { name: "NotFoundError" } })).toBe(true)
    expect(isSessionNotFoundError({ data: { name: "NotFoundError" } })).toBe(true)
  })

  test("ignores other failures", () => {
    expect(isSessionNotFoundError(new Error("delete request failed"))).toBe(false)
    expect(isSessionNotFoundError({ name: "UnknownError" })).toBe(false)
    expect(isSessionNotFoundError(null)).toBe(false)
  })
})

describe("homeRouteIfSessionNotFound", () => {
  test("prompt/command NotFound closes the conversation", () => {
    expect(homeRouteIfSessionNotFound({ status: 404 })).toEqual({ type: "home" })
    expect(homeRouteIfSessionNotFound({ name: "NotFoundError" })).toEqual({ type: "home" })
  })

  test("other send failures stay on the current route", () => {
    expect(homeRouteIfSessionNotFound(new Error("network"))).toBeUndefined()
    expect(homeRouteIfSessionNotFound({ name: "UnknownError" })).toBeUndefined()
  })
})

describe("session sync catch", () => {
  test("does not console.error NotFound onto the TUI", () => {
    const src = readFileSync(join(import.meta.dirname, "../../src/cli/cmd/tui/routes/session/index.tsx"), "utf8")
    const start = src.indexOf("await sync.session")
    const end = src.indexOf("const toast = useToast()")
    const effect = src.slice(start, end)
    expect(effect).toContain("homeRouteIfSessionNotFound")
    expect(effect).toContain("toast.sessionNotFound")
    expect(effect).toContain("if (home) navigate(home)")
    expect(effect).not.toContain("console.error")
  })
})
