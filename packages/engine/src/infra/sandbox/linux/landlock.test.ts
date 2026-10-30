import { describe, expect, test } from "vitest"
import { Landlock } from "./landlock"

describe("Landlock constants", () => {
  test("system call numbers (the same on x86_64 and aarch64) and flags", () => {
    expect(Landlock.SYS).toEqual({ createRuleset: 444, addRule: 445, restrictSelf: 446 })
    expect(Landlock.PRCTL).toEqual({ x64: 157, arm64: 167 })
    expect(Landlock.PR_SET_NO_NEW_PRIVS).toBe(38)
    expect(Landlock.O_PATH).toBe(0o10000000)
    expect(Landlock.RULE).toEqual({ PATH_BENEATH: 1, NET_PORT: 2 })
    expect(Landlock.NET.CONNECT_TCP).toBe(2)
  })

  test("file access bits 0 to 14", () => {
    expect(Landlock.FS).toEqual({
      EXECUTE: 1,
      WRITE_FILE: 2,
      READ_FILE: 4,
      READ_DIR: 8,
      REMOVE_DIR: 16,
      REMOVE_FILE: 32,
      MAKE_CHAR: 64,
      MAKE_DIR: 128,
      MAKE_REG: 256,
      MAKE_SOCK: 512,
      MAKE_FIFO: 1024,
      MAKE_BLOCK: 2048,
      MAKE_SYM: 4096,
      REFER: 8192,
      TRUNCATE: 16384,
    })
  })

  test("handled file rights grow with the ABI: REFER from 2, TRUNCATE from 3", () => {
    expect(Landlock.handled(1)).toBe(0x1fff)
    expect(Landlock.handled(2)).toBe(0x3fff)
    expect(Landlock.handled(3)).toBe(0x7fff)
    expect(Landlock.handled(7)).toBe(0x7fff)
  })

  test("a file can only get rights that make sense for a file", () => {
    expect(Landlock.read(false)).toBe(Landlock.FS.EXECUTE | Landlock.FS.READ_FILE)
    expect(Landlock.read(true)).toBe(Landlock.FS.EXECUTE | Landlock.FS.READ_FILE | Landlock.FS.READ_DIR)
    expect(Landlock.write(3, false)).toBe(
      Landlock.FS.EXECUTE | Landlock.FS.WRITE_FILE | Landlock.FS.READ_FILE | Landlock.FS.TRUNCATE,
    )
    expect(Landlock.write(1, false)).toBe(Landlock.FS.EXECUTE | Landlock.FS.WRITE_FILE | Landlock.FS.READ_FILE)
    expect(Landlock.write(3, true)).toBe(0x7fff)
  })
})

describe("Landlock structs (little endian)", () => {
  test("ruleset_attr is 8 bytes before ABI 4 and 16 bytes from ABI 4", () => {
    expect(Landlock.rulesetAttr(3, 0x7fff, 0).toString("hex")).toBe("ff7f000000000000")
    expect(Landlock.rulesetAttr(4, 0x7fff, 2).toString("hex")).toBe("ff7f0000000000000200000000000000")
  })

  test("path_beneath_attr is 12 packed bytes: u64 rights then s32 fd", () => {
    expect(Landlock.pathBeneath(0x0d, 7).toString("hex")).toBe("0d0000000000000007000000")
  })

  test("net_port_attr is 16 bytes: u64 rights then u64 port", () => {
    expect(Landlock.netPort(2, 8080).toString("hex")).toBe("0200000000000000901f000000000000")
  })
})
