import { expect, test } from "vitest"
import { kindKey, newRuleBody, ruleName } from "./rules-input"

test("a typed file name becomes the rule name the engine expects, without an extension", () => {
  expect(ruleName("testing")).toBe("testing")
  expect(ruleName("  testing.mdc ")).toBe("testing")
  expect(ruleName("TESTING.MDC")).toBe("TESTING")
  expect(ruleName("backend/api")).toBe("backend/api")
})

test("a name the engine would refuse is rejected before it is sent", () => {
  for (const bad of ["", "..", "a/../b", "a b", "a\b", ".mdc"]) expect(ruleName(bad)).toBeUndefined()
})

test("a new rule file starts with its settings so the editor opens on something to fill in", () => {
  const body = newRuleBody()
  expect(body).toContain("alwaysApply: false")
  expect(body.startsWith("---\n")).toBe(true)
})

test("each way a rule reaches the model has its own label", () => {
  expect(kindKey("always")).toBe("settings.rules.always")
  expect(kindKey("matching")).toBe("settings.rules.auto")
  expect(kindKey("described")).toBe("settings.rules.requested")
  expect(kindKey("something else")).toBeUndefined()
})
