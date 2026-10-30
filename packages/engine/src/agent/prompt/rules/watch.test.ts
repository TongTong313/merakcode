import { describe, expect, test } from "vitest"
import { RuleWatch } from "./watch"

describe("RuleWatch", () => {
  test("empty flushGlobal returns false", async () => {
    expect(await RuleWatch.__testingFlushGlobal()).toBe(false)
  })

  test("queued flushGlobal returns true", async () => {
    RuleWatch.__testingQueueGlobal()
    expect(await RuleWatch.__testingFlushGlobal()).toBe(true)
  })

  test("empty flushProject returns false", async () => {
    expect(await RuleWatch.__testingFlushProject("missing")).toBe(false)
  })

  test("treats instruction files and .mdc as watch targets", () => {
    expect(RuleWatch.__testingIsRuleFile("/w/AGENTS.md")).toBe(true)
    expect(RuleWatch.__testingIsRuleFile("/w/.cursor/rules/a.mdc")).toBe(true)
    expect(RuleWatch.__testingIsRuleFile("/w/readme.md")).toBe(false)
  })

  test("differs detects added and removed snapshot entries", () => {
    const before = new Map([["/w/AGENTS.md", 1]])
    const added = new Map([
      ["/w/AGENTS.md", 1],
      ["/w/.cursor/rules/a.mdc", 2],
    ])
    const removed = new Map<string, number>()
    expect(RuleWatch.__testingDiffers(before, added)).toBe(true)
    expect(RuleWatch.__testingDiffers(added, removed)).toBe(true)
    expect(RuleWatch.__testingDiffers(before, new Map([["/w/AGENTS.md", 1]]))).toBe(false)
  })
})
