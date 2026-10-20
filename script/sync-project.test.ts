import { describe, expect, test } from "vitest"
import { docLinks, license, packageMeta } from "./sync-project"

describe("license", () => {
  test("puts the year range and author into the MIT text", () => {
    const text = license({ author: "Jane Doe", since: 2026, year: 2027 })
    expect(text.startsWith("MIT License\n\nCopyright (c) 2026-2027 Jane Doe\n")).toBe(true)
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
  })

  test("uses a single year when nothing has changed since", () => {
    expect(license({ author: "Jane Doe", since: 2026, year: 2026 })).toContain("Copyright (c) 2026 Jane Doe\n")
  })

  test("ends by pointing at the notices for code derived from other projects", () => {
    const text = license({ author: "Jane Doe", since: 2026, year: 2026 })
    expect(text.trimEnd().endsWith("See THIRD_PARTY_NOTICES.md for their copyright notices and licenses.")).toBe(true)
    expect(text).toContain("opencode")
  })
})

describe("packageMeta", () => {
  test("adds repository, homepage and bugs pointing at the project repo", () => {
    const next = packageMeta(
      { name: "@merakcode/engine", version: "1.0.0" },
      { repository: "acme/merakcode", directory: "packages/engine" },
    )
    expect(next).toMatchObject({
      repository: { type: "git", url: "git+https://github.com/acme/merakcode.git", directory: "packages/engine" },
      homepage: "https://github.com/acme/merakcode",
      bugs: { url: "https://github.com/acme/merakcode/issues" },
    })
  })

  test("keeps every other field and its order", () => {
    const next = packageMeta(
      { name: "x", version: "1.0.0", scripts: { a: "b" } },
      { repository: "acme/merakcode", directory: "" },
    )
    expect(Object.keys(next).slice(0, 3)).toEqual(["name", "version", "scripts"])
    expect(next.repository).toEqual({ type: "git", url: "git+https://github.com/acme/merakcode.git" })
  })
})

describe("docLinks", () => {
  test("moves GitHub links to the old repo over to the new one and leaves other links alone", () => {
    const text = [
      "curl -fsSL https://github.com/OWNER/merakcode/releases/latest/download/install.sh | sh",
      '"$schema": "https://raw.githubusercontent.com/OWNER/merakcode/main/schema/config.json"',
      "see https://github.com/other/project",
    ].join("\n")
    expect(docLinks(text, { from: "OWNER/merakcode", to: "acme/merak-code" })).toBe(
      [
        "curl -fsSL https://github.com/acme/merak-code/releases/latest/download/install.sh | sh",
        '"$schema": "https://raw.githubusercontent.com/acme/merak-code/main/schema/config.json"',
        "see https://github.com/other/project",
      ].join("\n"),
    )
  })
})
