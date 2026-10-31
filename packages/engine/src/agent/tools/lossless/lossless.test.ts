import { describe, expect, test } from "vitest"
import { stripAnsi } from "./ansi"
import { foldRepeatedBlocks, unfoldRepeatedBlocks } from "./blocks"
import { stripDiffIndex } from "./diff"
import { pathHeading, pathUnheading, searchHeading, searchUnheading } from "./heading"
import { collapseRuns, expandRuns } from "./runs"
import { compactLossless, defaultConfig } from "./index"

describe("stripAnsi", () => {
  test("strips color codes and keeps the text", () => {
    expect(stripAnsi("\x1b[31mFAILED\x1b[0m test_foo")).toBe("FAILED test_foo")
  })

  test("returns the same string reference when there are no escape sequences", () => {
    const text = "plain output"
    expect(stripAnsi(text)).toBe(text)
  })

  test("strips cursor movement and OSC sequences", () => {
    expect(stripAnsi("a\x1b[2Kb\x1b]0;title\x07c")).toBe("abc")
  })
})

describe("collapseRuns / expandRuns", () => {
  test("collapses adjacent repeated lines and restores them exactly", () => {
    const text = "start\nsame\nsame\nsame\nend\n"
    const folded = collapseRuns(text)
    expect(folded).toBe("start\nsame\n... (repeated 3 times)\nend\n")
    expect(expandRuns(folded)).toBe(text)
  })

  test("adds no marker when nothing repeats", () => {
    const text = "a\nb\nc"
    expect(collapseRuns(text)).toBe(text)
  })

  test("preserves whether the text ends with a newline", () => {
    expect(expandRuns(collapseRuns("x\nx"))).toBe("x\nx")
    expect(expandRuns(collapseRuns("x\nx\n"))).toBe("x\nx\n")
  })

  test("restores CRLF output byte for byte", () => {
    const text = "a\r\na\r\nb\r\n"
    expect(expandRuns(collapseRuns(text))).toBe(text)
  })

  test("handles empty strings and single lines", () => {
    expect(collapseRuns("")).toBe("")
    expect(collapseRuns("only")).toBe("only")
  })
})

describe("foldRepeatedBlocks / unfoldRepeatedBlocks", () => {
  test("folds non-adjacent repeated blocks and restores them exactly", () => {
    const stanza = ["  image: nginx", "  ports:", "    - 80", "  resources: {}"]
    const text = ["- name: a", ...stanza, "- name: b", ...stanza, ""].join("\n")
    const folded = foldRepeatedBlocks(text)
    expect(folded).toContain("... (repeats 4 lines from")
    expect(unfoldRepeatedBlocks(folded)).toBe(text)
  })

  test("does not fold when there are too few lines", () => {
    const text = "a\nb\nc"
    expect(foldRepeatedBlocks(text)).toBe(text)
  })

  test("leaves blocks shorter than the marker unchanged", () => {
    // Three one-character lines are 6 bytes, far less than the marker itself
    const text = "a\nb\nc\na\nb\nc\n"
    expect(foldRepeatedBlocks(text)).toBe(text)
  })
})

describe("searchHeading / searchUnheading", () => {
  test("groups grep lines by file and restores them exactly", () => {
    const text = ["src/a.ts:1:foo", "src/a.ts:9:bar", "src/b.ts:3:baz", ""].join("\n")
    const folded = searchHeading(text)
    expect(folded).toBe(["src/a.ts", "1:foo", "9:bar", "src/b.ts", "3:baz", ""].join("\n"))
    expect(searchUnheading(folded)).toBe(text)
  })

  test("passes non-grep lines through and ends the current group", () => {
    const text = ["src/a.ts:1:foo", "-- separator --", "src/a.ts:2:bar", ""].join("\n")
    expect(searchUnheading(searchHeading(text))).toBe(text)
  })
})

describe("pathHeading / pathUnheading", () => {
  test("groups path lists by directory and restores them exactly", () => {
    const text = ["src/tool/a.ts", "src/tool/b.ts", "src/session/c.ts", ""].join("\n")
    const folded = pathHeading(text)
    expect(folded).toBe(["src/tool/", "a.ts", "b.ts", "src/session/", "c.ts", ""].join("\n"))
    expect(pathUnheading(folded)).toBe(text)
  })

  test("leaves text with fewer than two path lines unchanged", () => {
    const text = "src/only.ts\nplain text\n"
    expect(pathHeading(text)).toBe(text)
  })
})

describe("stripDiffIndex", () => {
  test("removes index lines", () => {
    const text = ["diff --git a/x b/x", "index 1234abc..5678def 100644", "@@ -1 +1 @@", "-a", "+b", ""].join("\n")
    expect(stripDiffIndex(text)).toBe(["diff --git a/x b/x", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"))
  })

  test("keeps index-like lines in text that is not a diff", () => {
    const text = "index 1234abc..5678def\njust a coincidence\n"
    expect(stripDiffIndex(text)).toBe(text)
  })
})

describe("compactLossless", () => {
  const config = { ...defaultConfig(), minBytes: 0 }

  test("stacks several transforms and records the order they were applied", () => {
    const text = `\x1b[31m${"warn: retry\n".repeat(40)}\x1b[0m`
    const result = compactLossless(text, config)
    expect(result).not.toBeNull()
    expect(result!.applied).toContain("ansi")
    expect(result!.applied).toContain("runs")
    expect(result!.compactedBytes).toBeLessThan(result!.originalBytes)
  })

  test("returns null when nothing can be compacted", () => {
    expect(compactLossless("a\nb\nc\n", config)).toBeNull()
  })

  test("skips input smaller than minBytes", () => {
    const text = "same\n".repeat(10)
    expect(compactLossless(text, { ...config, minBytes: 10_000 })).toBeNull()
  })

  test("returns null when disabled", () => {
    const text = "same\n".repeat(100)
    expect(compactLossless(text, { ...config, enabled: false })).toBeNull()
  })

  test("round-trip check rejects runs when the input already contains a run marker", () => {
    // A literal "... (repeated 2 times)" after "x" would expand into two copies of x. The many "y" lines make folding
    // pay off in bytes, so only the round-trip check can reject it, not the size check.
    const text = ["x", "... (repeated 2 times)", ...Array(50).fill("y")].join("\n") + "\n"
    const result = compactLossless(text, config)
    expect(result?.applied ?? []).not.toContain("runs")
  })

  test("any accepted combination of reversible transforms restores the input", () => {
    const samples = [
      "x\n".repeat(200),
      ["a.ts:1:x", "a.ts:2:y", "b.ts:1:z"].join("\n").repeat(30),
      ["src/x/a.ts", "src/x/b.ts", "src/y/c.ts"].join("\n").repeat(30),
      ["- name: a", "  p: 1", "  q: 2", "  r: 3", "- name: b", "  p: 1", "  q: 2", "  r: 3"].join("\n").repeat(20),
    ]
    for (const sample of samples) {
      const result = compactLossless(sample, config)
      if (!result) continue
      // Undo transforms in reverse order; the result must equal the input with ANSI stripped
      let restored = result.output
      for (const name of [...result.applied].reverse()) {
        if (name === "runs") restored = expandRuns(restored)
        if (name === "blocks") restored = unfoldRepeatedBlocks(restored)
        if (name === "search-heading") restored = searchUnheading(restored)
        if (name === "path-heading") restored = pathUnheading(restored)
      }
      expect(restored).toBe(stripAnsi(sample))
    }
  })

  test("the accepted transforms together always make the output smaller", () => {
    const samples = [
      "x\n".repeat(500),
      `\x1b[32mok\x1b[0m\n`.repeat(300),
      ["src/a.ts:1:f", "src/a.ts:2:g", "src/a.ts:3:h"].join("\n").repeat(20),
    ]
    for (const sample of samples) {
      const result = compactLossless(sample, config)
      if (result) expect(result.compactedBytes).toBeLessThan(result.originalBytes)
    }
  })
})
