import { describe, expect, test } from "vitest"
import { Report } from "./report"

describe("Report.render", () => {
  test("nothing blocked and the command worked: no text", () => {
    expect(Report.render({ blocked: [], restored: [], output: "ok", exitCode: 0 })).toBe("")
  })

  test("names the hosts that were refused and says not to retry them", () => {
    const text = Report.render({ blocked: ["a.test", "b.test"], restored: [], output: "", exitCode: 1 })
    expect(text).toContain("[MRK-5005]")
    expect(text).toContain("a.test, b.test")
    expect(text).toMatch(/do not retry/i)
  })

  test("lists git files that were put back", () => {
    const text = Report.render({ blocked: [], restored: ["/w/.git/hooks/pre-commit"], output: "", exitCode: 0 })
    expect(text).toContain("[MRK-5004]")
    expect(text).toContain("/w/.git/hooks/pre-commit")
  })

  test("a failed command with a permission error points at writable_paths and unsandboxed", () => {
    for (const output of [
      "EPERM: operation not permitted, open '/etc/x'",
      "Access is denied.",
      "touch: cannot touch '/opt/x': Permission denied",
      "mkdir: /usr/x: Read-only file system",
    ]) {
      const text = Report.render({ blocked: [], restored: [], output, exitCode: 1 })
      expect(text, output).toContain("writable_paths")
      expect(text, output).toContain("unsandboxed")
    }
  })

  test("a permission message from a command that succeeded is not reported", () => {
    expect(Report.render({ blocked: [], restored: [], output: "Permission denied (ignored)", exitCode: 0 })).toBe("")
  })
})
