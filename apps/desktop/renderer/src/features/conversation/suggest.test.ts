import { describe, expect, test } from "vitest"
import { apply, fileUrl, trigger } from "./suggest"

describe("composer suggestions", () => {
  test("suggests files after a standalone @ and commands only for a leading / without spaces", () => {
    expect(trigger("看看 @no", 6)).toEqual({ kind: "file", query: "no", start: 3, end: 6 })
    expect(trigger("@", 1)).toEqual({ kind: "file", query: "", start: 0, end: 1 })
    expect(trigger("mail@x", 6)).toBeUndefined()
    expect(trigger("/hel", 4)).toEqual({ kind: "command", query: "hel", start: 0, end: 4 })
    expect(trigger("/hello 世界", 9)).toBeUndefined()
    expect(trigger("看 /x", 4)).toBeUndefined()
  })

  test("replaces the trigger with the choice plus a space and puts the caret after the space", () => {
    const at = trigger("看看 @no 再说", 6)!
    expect(apply("看看 @no 再说", at, "notes.txt")).toEqual({ text: "看看 @notes.txt 再说", caret: 14 })
    expect(apply("/hel", trigger("/hel", 4)!, "hello")).toEqual({ text: "/hello ", caret: 7 })
  })

  test("converts a local path to a file URL, keeping drive letters and encoding spaces, non-ASCII and #", () => {
    expect(fileUrl("C:/项目 a/x#1.ts")).toBe("file:///C:/%E9%A1%B9%E7%9B%AE%20a/x%231.ts")
    expect(fileUrl("/home/u/a.ts")).toBe("file:///home/u/a.ts")
  })
})
