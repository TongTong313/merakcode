import { describe, expect, test } from "vitest"
import { baseName, decodeDir, encodeDir, relative, sameDir, sessionPath } from "./route"

describe("in-app routes", () => {
  test("encodes a directory as a URL-safe segment that round-trips non-ASCII, spaces and backslashes", () => {
    for (const dir of ["/home/me/项目 a", "C:\\Users\\me\\code", "/"]) {
      const segment = encodeDir(dir)
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(decodeDir(segment)).toBe(dir)
    }
    expect(sessionPath("/p", "ses_1")).toBe(`/${encodeDir("/p")}/session/ses_1`)
    expect(sessionPath("/p")).toBe(`/${encodeDir("/p")}/session`)
  })

  test("matches spellings of the same directory and derives base names and relative paths", () => {
    expect(sameDir("C:\\Code\\App\\", "c:/code/app", "win32")).toBe(true)
    expect(sameDir("/a/B", "/a/b", "linux")).toBe(false)
    expect(baseName("/home/me/merakcode/")).toBe("merakcode")
    expect(baseName("D:\\code\\blog")).toBe("blog")
    expect(relative("/p", "/p/src/a.ts")).toBe("src/a.ts")
    expect(relative("/p", "/q/a.ts")).toBe("/q/a.ts")
  })
})
