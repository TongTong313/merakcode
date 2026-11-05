import { describe, expect, test } from "vitest"
import { binMap, commandName, packageName, platformPackage } from "../../bin/cli-name.cjs"

describe("command and package names", () => {
  test("there is exactly one command, merak", () => {
    expect(commandName).toBe("merak")
    expect(binMap()).toEqual({ merak: "./bin/merak" })
  })

  test("npm packages keep the product id merakcode; Windows is spelled windows", () => {
    expect(packageName).toBe("merakcode")
    expect(platformPackage("win32", "x64")).toBe("merakcode-windows-x64")
    expect(platformPackage("darwin", "arm64")).toBe("merakcode-darwin-arm64")
    expect(platformPackage("linux", "arm64")).toBe("merakcode-linux-arm64")
  })
})
