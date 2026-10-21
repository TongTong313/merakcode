import { describe, expect, test } from "vitest"
import { Process } from "@merakcode/util/process"
import { cli } from "../fixture/fixture"
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

  test("help lists the commands under merak", async () => {
    const proc = Process.spawn([...cli, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code, stderr).toBe(0)
    expect(stdout).toContain("merak serve")
    expect(stdout).not.toContain("merakcode serve")
  })
})
