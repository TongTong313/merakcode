import { describe, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { mainPackage, npmTag, platformPackages, publishScript, sameVersion } from "../../script/pack"
import { Filesystem } from "@merakcode/util/filesystem"

async function platform(dist: string, name: string, version: string) {
  await Filesystem.write(
    path.join(dist, `${name.replace("merakcode-", `merakcode-${version}-`)}`, "package.json"),
    JSON.stringify({ name, version }),
  )
}

describe("npm release preparation", () => {
  test("the main package lists every platform package as optional and has merak as its only command", () => {
    const main = mainPackage(
      { name: "merakcode", version: "1.2.0", license: "MIT" },
      {
        "merakcode-linux-x64": "1.2.0",
        "merakcode-windows-x64": "1.2.0",
      },
    )
    expect(main.optionalDependencies).toEqual({ "merakcode-linux-x64": "1.2.0", "merakcode-windows-x64": "1.2.0" })
    expect(main.bin).toEqual({ merak: "./bin/merak" })
    expect(main.files).toEqual(["bin", "THIRD_PARTY_NOTICES.md"])
  })

  test("only platform directories built by build.ts count, and a version other than the CLI's throws", async () => {
    await using tmp = await tmpdir()
    await platform(tmp.path, "merakcode-linux-x64", "1.2.0")
    await platform(tmp.path, "merakcode-darwin-arm64", "1.2.0")
    await fs.mkdir(path.join(tmp.path, "lib"))
    expect(Object.keys(platformPackages(tmp.path, "1.2.0")).sort()).toEqual([
      "merakcode-darwin-arm64",
      "merakcode-linux-x64",
    ])
    await platform(tmp.path, "merakcode-windows-x64", "1.1.0")
    expect(() => platformPackages(tmp.path, "1.2.0")).toThrow("does not match the CLI version 1.2.0")
  })

  const packed = (name: string) => ({
    name,
    version: "1.2.0",
    file: `${name.replace("@", "").replace("/", "-")}-1.2.0.tgz`,
  })

  test("the publish script publishes the packed files: platform packages first, then the SDK, then the main package", () => {
    const script = publishScript(
      [packed("merakcode-linux-x64"), packed("merakcode-darwin-arm64")],
      [packed("@merakcode/sdk"), packed("merakcode")],
    )
    const order = [
      'publish "merakcode-linux-x64" "1.2.0" "merakcode-linux-x64-1.2.0.tgz"',
      'publish "merakcode-darwin-arm64" "1.2.0" "merakcode-darwin-arm64-1.2.0.tgz"',
      'publish "@merakcode/sdk" "1.2.0" "merakcode-sdk-1.2.0.tgz"',
      'publish "merakcode" "1.2.0" "merakcode-1.2.0.tgz"',
    ].map((line) => script.indexOf(line))
    expect(order.every((at) => at > 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(script).toContain('npm publish --access public --tag latest "./$3"')
  })

  test("releases go out under latest, pre-releases under their channel name", () => {
    expect(npmTag("1.2.0")).toBe("latest")
    expect(npmTag("1.2.0-beta.1")).toBe("beta")
    expect(npmTag("2.0.0-rc.3")).toBe("rc")
    expect(publishScript([packed("p")], [packed("merakcode")], "beta")).toContain("--tag beta ")
  })

  test("the SDK must have the CLI's version, otherwise nothing is prepared", () => {
    expect(() =>
      sameVersion({ name: "merakcode", version: "1.2.0" }, { name: "@merakcode/sdk", version: "1.2.0" }),
    ).not.toThrow()
    expect(() =>
      sameVersion({ name: "merakcode", version: "1.2.0" }, { name: "@merakcode/sdk", version: "1.1.0" }),
    ).toThrow("@merakcode/sdk is at 1.1.0 but merakcode is at 1.2.0")
  })
})
