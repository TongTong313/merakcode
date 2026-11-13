import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

const read = (name: string) => readFileSync(path.join(import.meta.dirname, name), "utf8")
const tokens = read("tokens.css")
const spaces = [4, 8, 12, 16, 20, 24, 32, 40]

/** The parts of app.css that style the new pages: settings pages, group, home, agents, tasks */
function pages() {
  const app = read("app.css")
  const slice = (from: string, to?: string) => {
    const start = app.indexOf(from)
    expect(start, from).toBeGreaterThanOrEqual(0)
    return app.slice(start, to ? app.indexOf(to, start) : undefined)
  }
  return [slice("/* Settings */", "/* Onboarding */"), slice("/* Conversation body")].join("\n")
}

describe("design tokens", () => {
  test("--space-1 to --space-8 are 4, 8, 12, 16, 20, 24, 32, 40 px", () => {
    for (const [index, size] of spaces.entries())
      expect(tokens, `--space-${index + 1}`).toContain(`--space-${index + 1}: ${size}px;`)
  })

  test("stacking order comes from --z-* tokens, not numbers", () => {
    expect(tokens).toMatch(/--z-popover: 50;/)
    for (const name of ["app.css", "base.css", "panels.css"])
      expect(read(name).match(/z-index:\s*-?\d+/g) ?? [], name).toEqual([])
  })

  test("the new pages write spacing with --space tokens wherever the value is on the scale", () => {
    const spacing = /^\s*(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?:\s*(.+);/gm
    const stray = [...pages().matchAll(spacing)]
      .filter((match) =>
        [...(match[1] ?? "").matchAll(/(?<![\w.-])(\d+)px\b/g)].some((px) => spaces.includes(Number(px[1]))),
      )
      .map((match) => match[0].trim())
    expect(stray).toEqual([])
  })
})
