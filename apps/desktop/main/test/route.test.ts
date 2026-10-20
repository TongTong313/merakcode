import { describe, expect, test } from "vitest"
import { Route } from "../src/route"

const win = (...parts: string[]) => parts.join("\\")

describe("window routes", () => {
  test("encodes directory and session into the path and decodes it back (non-ASCII and Windows paths)", () => {
    for (const directory of ["/home/me/项目", win("D:", "code", "demo")]) {
      const route = Route.of({ directory, sessionID: "ses_1" })
      expect(route).toMatch(/^\/[A-Za-z0-9_-]+\/session\/ses_1$/)
      expect(Route.directory(`http://127.0.0.1:4000${route}`)).toBe(directory)
    }
    expect(Route.of()).toBe("/")
    expect(Route.directory("http://127.0.0.1:4000/")).toBeUndefined()
  })

  test("deep links only accept open-project", () => {
    expect(Route.deepLink("merakcode://open-project?directory=%2Ftmp%2Fa")).toBe("/tmp/a")
    expect(Route.deepLink("merakcode://other?directory=/tmp")).toBeUndefined()
    expect(Route.deepLink("https://open-project?directory=/tmp")).toBeUndefined()
  })

  test("different spellings of one directory are the same project", () => {
    expect(Route.same(win("C:", "Code", "Demo", ""), "c:/code/demo", "win32")).toBe(true)
    expect(Route.same("/home/a/Demo", "/home/a/demo", "linux")).toBe(false)
  })
})
