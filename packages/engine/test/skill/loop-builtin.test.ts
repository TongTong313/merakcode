import { describe, expect, test } from "vitest"
import { getBuiltinSkill } from "@merakcode/engine/skill/builtin"
import { CronCreateTool } from "@merakcode/engine/tool/loop"

const content = getBuiltinSkill("loop")?.content ?? ""

describe("loop builtin", () => {
  test("rendered parsing regexes keep their backslashes and extract numbers from user input", () => {
    const patterns = Object.fromEntries(
      [...content.matchAll(/^- (Seconds|Minutes|Hours): `(.+)`$/gm)].map((match) => [match[1], new RegExp(match[2]!)]),
    )
    expect(Object.keys(patterns)).toEqual(["Seconds", "Minutes", "Hours"])
    expect(patterns.Seconds!.source).toContain("\\d+")
    expect(patterns.Seconds!.exec("/loop 90 seconds ping")?.[1]).toBe("90")
    expect(patterns.Minutes!.exec("/loop 5m run check_url.sh")?.[1]).toBe("5")
    expect(patterns.Hours!.exec("check the build every 2 hours")?.[1]).toBe("2")
  })

  test("every example interval passes CronCreate parameter validation", async () => {
    const { parameters } = await CronCreateTool.init()
    const intervals = [...content.matchAll(/→ (\d+)/g)].map((match) => Number(match[1]))
    expect(intervals.length).toBeGreaterThan(0)
    expect(intervals.filter((interval) => !parameters.safeParse({ interval, prompt: "x" }).success)).toEqual([])
    // Interval prefixes in examples (such as /loop 5m) must respect the minimum too, so no seconds examples.
    expect(content).not.toMatch(/\/loop \d+s\b/)
  })
})
