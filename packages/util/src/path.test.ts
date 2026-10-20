import { test, expect, describe } from "vitest"
import { formatToolDirectory } from "./path"

describe("formatToolDirectory", () => {
  const base = "D:/code/alibaba-cn-code"

  test("shows the project root (the tool's default search directory) when path is omitted", () => {
    expect(formatToolDirectory(undefined, base)).toBe(base)
  })

  test("path equal to the project root gives '.'", () => {
    expect(formatToolDirectory(base, base)).toBe(".")
  })

  test("a subdirectory of the project gives a relative path", () => {
    expect(formatToolDirectory("D:/code/alibaba-cn-code/packages/ui", base)).toBe("packages/ui")
  })

  test("a path outside the project is returned as is", () => {
    expect(formatToolDirectory("C:/Windows", base)).toBe("C:/Windows")
  })

  test("relativizes against a Windows backslash base (mixed separators)", () => {
    expect(formatToolDirectory("D:/code/alibaba-cn-code/src", "D:\\code\\alibaba-cn-code")).toBe("src")
  })

  test("relativizes a Windows backslash path against a forward-slash base", () => {
    expect(formatToolDirectory("D:\\code\\alibaba-cn-code\\src", "D:/code/alibaba-cn-code")).toBe("src")
  })

  test("trailing slashes do not affect the comparison", () => {
    expect(formatToolDirectory("D:/code/alibaba-cn-code/", base)).toBe(".")
    expect(formatToolDirectory(base, "D:/code/alibaba-cn-code/")).toBe(".")
  })

  test("does not strip the project root down to its parent D:/code/", () => {
    // getDirectory treats its input as a file path and would return "D:/code/" here
    expect(formatToolDirectory(base, base)).not.toBe("D:/code/")
  })

  test("only normalizes separators when there is no base", () => {
    expect(formatToolDirectory("D:\\code\\alibaba-cn-code", undefined)).toBe("D:/code/alibaba-cn-code")
    expect(formatToolDirectory("D:\\code\\alibaba-cn-code", "")).toBe("D:/code/alibaba-cn-code")
  })

  test("both path and base empty", () => {
    expect(formatToolDirectory(undefined, undefined)).toBe(".")
    expect(formatToolDirectory("", "")).toBe(".")
  })

  test("Linux/macOS style paths", () => {
    expect(formatToolDirectory("/home/user/proj/src", "/home/user/proj")).toBe("src")
    expect(formatToolDirectory("/home/user/proj", "/home/user/proj")).toBe(".")
    expect(formatToolDirectory("/etc/hosts", "/home/user/proj")).toBe("/etc/hosts")
  })

  test("a sibling sharing the prefix is not a subdirectory (alibaba-cn-code vs alibaba-cn-code-backup)", () => {
    expect(formatToolDirectory("D:/code/alibaba-cn-code-backup", "D:/code/alibaba-cn-code")).toBe(
      "D:/code/alibaba-cn-code-backup",
    )
  })
})
