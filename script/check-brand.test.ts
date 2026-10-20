import { describe, expect, test } from "vitest"
import { privateTerms, violations } from "./check-brand"

describe("check-brand", () => {
  test("flags every spelling of the old product name", () => {
    const found = violations([
      {
        path: "a.ts",
        text: 'const name = "MythCode"\n// Myth Code\nprocess.env.MYTHCODE_X\nimport x from "@mythcode/util"\n',
      },
    ])
    expect(found.map((item) => [item.line, item.term])).toEqual([
      [1, "MythCode"],
      [2, "Myth Code"],
      [3, "MYTHCODE"],
      [4, "mythcode"],
    ])
  })

  test("flags the old command but not longer words that start with it", () => {
    const found = violations([{ path: "README.md", text: "run `myth upgrade`\nGreek mythology and myths\nMyth run\n" }])
    expect(found.map((item) => [item.line, item.term])).toEqual([
      [1, "myth"],
      [3, "Myth"],
    ])
  })

  test("flags extra private terms, one regex per line, and ignores comments and blank lines", () => {
    const terms = privateTerms("# kept out of the public repo\nacme[\\s_-]?corp\n\n(?<!\\d)555(?!\\d)\n")
    const text = "Acme Corp, acme-corp and AcmeCorp\ncall 555, not 5550\n"
    const found = violations([{ path: "notes.txt", text }], [], terms)
    expect(found.map((item) => [item.line, item.term])).toEqual([
      [1, "Acme Corp"],
      [1, "acme-corp"],
      [1, "AcmeCorp"],
      [2, "555"],
    ])
  })

  test("without private terms only the public rules apply", () => {
    expect(privateTerms("")).toEqual([])
    expect(violations([{ path: "notes.txt", text: "Acme Corp" }])).toEqual([])
  })

  test("flags unfilled placeholders; AUTHOR only counts inside LICENSE", () => {
    const found = violations([
      { path: "package.json", text: '"url": "https://github.com/OWNER/merakcode"\n"AUTHOR"\n' },
      { path: "LICENSE", text: "MIT License\n\nCopyright (c) 2026 AUTHOR\n" },
    ])
    expect(found.map((item) => [item.file, item.line, item.term])).toEqual([
      ["package.json", 1, "OWNER/"],
      ["LICENSE", 3, "AUTHOR"],
    ])
  })

  test("flags old names in file paths", () => {
    const found = violations([
      { path: "apps/cli/bin/myth", text: "" },
      { path: "apps/cli/src/cli/cmd/tui/context/theme/mythcode.json", text: "{}" },
      { path: "docs/mythology.md", text: "" },
    ])
    expect(found.map((item) => [item.file, item.line, item.term])).toEqual([
      ["apps/cli/bin/myth", 0, "myth"],
      ["apps/cli/src/cli/cmd/tui/context/theme/mythcode.json", 0, "mythcode"],
    ])
  })

  test("skips files listed in the allowlist", () => {
    const files = [
      { path: "script/check-brand.test.ts", text: "MythCode" },
      { path: "docs/a.md", text: "MythCode" },
    ]
    expect(violations(files, ["script/check-brand.test.ts"]).map((item) => item.file)).toEqual(["docs/a.md"])
    expect(violations(files, ["docs/**"]).map((item) => item.file)).toEqual(["script/check-brand.test.ts"])
  })
})
