import { describe, expect, test } from "vitest"
import { WindowsCommand } from "./command"

describe("WindowsCommand.quote", () => {
  test("leaves simple words alone", () => {
    expect(WindowsCommand.quote("abc")).toBe("abc")
    expect(WindowsCommand.quote("C:\\dir\\file.txt")).toBe("C:\\dir\\file.txt")
  })

  test("quotes spaces and empty strings", () => {
    expect(WindowsCommand.quote("a b")).toBe('"a b"')
    expect(WindowsCommand.quote("")).toBe('""')
  })

  test("escapes quotes and the backslashes in front of them", () => {
    expect(WindowsCommand.quote('q"x')).toBe('"q\\"x"')
    expect(WindowsCommand.quote('a\\"b')).toBe('"a\\\\\\"b"')
  })

  test("doubles trailing backslashes inside quotes", () => {
    expect(WindowsCommand.quote("c:\\path with space\\")).toBe('"c:\\path with space\\\\"')
  })

  test("keeps Chinese as is", () => {
    expect(WindowsCommand.quote("中文 路径")).toBe('"中文 路径"')
  })
})

describe("WindowsCommand.line", () => {
  test("cmd gets the command verbatim, like Node does", () => {
    expect(WindowsCommand.line("C:\\Windows\\System32\\cmd.exe", 'echo "hi" & dir')).toBe('/d /s /c "echo "hi" & dir"')
    expect(WindowsCommand.line("CMD", "ver")).toBe('/d /s /c "ver"')
  })

  test("other shells get -c and one quoted argument", () => {
    expect(WindowsCommand.line("C:\\Program Files\\Git\\bin\\bash.exe", 'echo "a b"')).toBe('-c "echo \\"a b\\""')
    expect(WindowsCommand.line("pwsh", "Get-Date")).toBe("-c Get-Date")
  })
})

describe("WindowsCommand.request", () => {
  test("fields and environment are separated by NUL", () => {
    const text = WindowsCommand.request({
      user: "merakcode-sbx",
      password: "C:\\p.bin",
      cwd: "C:\\work",
      file: "C:\\Windows\\System32\\cmd.exe",
      args: '/d /s /c "ver"',
      env: { PATH: "C:\\bin", EMPTY: "" },
    })
    expect(text.split("\0")).toEqual([
      "merakcode-sbx",
      "C:\\p.bin",
      "C:\\work",
      "C:\\Windows\\System32\\cmd.exe",
      '/d /s /c "ver"',
      "PATH=C:\\bin",
      "EMPTY=",
    ])
  })

  test("refuses NUL inside a field, which would shift every field after it", () => {
    expect(() =>
      WindowsCommand.request({ user: "u", password: "p", cwd: "c", file: "f", args: "a\0b", env: {} }),
    ).toThrow(/NUL/)
  })
})

describe("WindowsCommand.BLOCKED", () => {
  test("covers every address except loopback", () => {
    expect(WindowsCommand.BLOCKED).toEqual([
      "0.0.0.0-126.255.255.255",
      "128.0.0.0-255.255.255.255",
      "::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ])
  })
})
