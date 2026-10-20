import { describe, expect, test } from "vitest"
import { merge, render } from "./licenses"

const report = (entries: { name: string; versions: string[]; license: string; paths: string[] }[]) =>
  Object.groupBy(entries, (entry) => entry.license) as Record<string, typeof entries>

describe("licenses", () => {
  test("merges reports from several workspace packages without duplicates, sorted by name", () => {
    const merged = merge([
      report([
        { name: "zod", versions: ["4.0.0"], license: "MIT", paths: ["/a/zod"] },
        { name: "hono", versions: ["4.1.0"], license: "MIT", paths: ["/a/hono"] },
      ]),
      report([{ name: "zod", versions: ["4.0.0", "3.0.0"], license: "MIT", paths: ["/b/zod"] }]),
    ])
    expect(merged.map((entry) => [entry.name, entry.versions])).toEqual([
      ["hono", ["4.1.0"]],
      ["zod", ["3.0.0", "4.0.0"]],
    ])
  })

  test("renders each package with its license text, or the license id when no file is found", () => {
    const text = render(
      [
        { name: "hono", versions: ["4.1.0"], license: "MIT", paths: ["/a/hono"] },
        { name: "tiny", versions: ["1.0.0"], license: "ISC", paths: ["/a/tiny"] },
      ],
      (dir) => (dir === "/a/hono" ? "MIT License\n\nCopyright (c) Yusuke Wada" : undefined),
    )
    expect(text).toContain("hono@4.1.0 (MIT)")
    expect(text).toContain("Copyright (c) Yusuke Wada")
    expect(text).toContain("tiny@1.0.0 (ISC)")
    expect(text).toContain("License text not included in the package; see the ISC license.")
  })
})
