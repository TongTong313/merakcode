import { describe, expect, test } from "vitest"
import { parse } from "yaml"
import { merge } from "../script/update-manifest"

const arm = `version: 0.2.0
files:
  - url: MerakCode-0.2.0-darwin-arm64.zip
    sha512: aaa
    size: 100
  - url: MerakCode-0.2.0-darwin-arm64.dmg
    sha512: bbb
    size: 120
path: MerakCode-0.2.0-darwin-arm64.zip
sha512: aaa
releaseDate: '2026-10-20T08:00:00.000Z'
`

const intel = `version: 0.2.0
files:
  - url: MerakCode-0.2.0-darwin-x64.zip
    sha512: ccc
    size: 110
  - url: MerakCode-0.2.0-darwin-arm64.dmg
    sha512: bbb
    size: 120
path: MerakCode-0.2.0-darwin-x64.zip
sha512: ccc
releaseDate: '2026-10-20T09:00:00.000Z'
`

describe("merge mac update manifests", () => {
  test("one manifest lists both architectures, each file once", () => {
    const merged = parse(merge(arm, intel))
    expect(merged.version).toBe("0.2.0")
    expect(merged.files.map((file: { url: string }) => file.url)).toEqual([
      "MerakCode-0.2.0-darwin-arm64.zip",
      "MerakCode-0.2.0-darwin-arm64.dmg",
      "MerakCode-0.2.0-darwin-x64.zip",
    ])
  })

  test("keeps the first manifest's main file and the later release date", () => {
    const merged = parse(merge(arm, intel))
    expect(merged.path).toBe("MerakCode-0.2.0-darwin-arm64.zip")
    expect(merged.sha512).toBe("aaa")
    expect(merged.releaseDate).toBe("2026-10-20T09:00:00.000Z")
  })

  test("refuses manifests of different versions", () => {
    expect(() => merge(arm, intel.replaceAll("0.2.0", "0.2.1"))).toThrow(/0\.2\.0.*0\.2\.1/)
  })
})
