/**
 * In non-interactive runs (merak run), operations that need approval are denied; the message shows the config
 * rule that would allow them in advance.
 */
import { test, expect } from "vitest"
import { permissionDeniedCopy } from "../../src/cli/cmd/run"

test("permissionDeniedCopy names the denied operation and gives an allow rule ready to paste", () => {
  const c = permissionDeniedCopy("bash_risky", ["git push origin main"])
  expect(c.uiLine).toContain("bash_risky: git push origin main")
  expect(c.message).toContain(".merakcode/merakcode.json")
  expect(c.message).toContain(JSON.stringify({ permission: { bash_risky: { "git push origin main": "allow" } } }))
})
