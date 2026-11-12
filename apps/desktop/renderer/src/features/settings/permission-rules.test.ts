import { expect, test } from "vitest"
import { projectRules, ruleFromInput, sameRule } from "./permission-rules"

test("a command pattern becomes a command prefix for the project, without its trailing wildcard", () => {
  expect(ruleFromInput("bash", "npm test *", "allow", "/work/app")).toEqual({
    project: "/work/app",
    commandPrefix: "npm test",
    decision: "allow",
  })
  expect(ruleFromInput("bash", "git push:*", "deny", "/work/app")?.commandPrefix).toBe("git push")
  expect(ruleFromInput("bash", "  make  ", "ask", "/work/app")?.commandPrefix).toBe("make")
})

test("a file pattern becomes a path prefix for written files", () => {
  expect(ruleFromInput("edit", "docs/**", "ask", "/work/app")).toEqual({
    project: "/work/app",
    pathPrefix: "docs",
    decision: "ask",
  })
})

test("a pattern that is only a wildcard, empty, or has a wildcard in the middle cannot be a prefix", () => {
  for (const bad of ["", "   ", "*", "**", "src/*/x", "a?b", "[ab]c"])
    expect(ruleFromInput("bash", bad, "allow", "/work/app"), bad).toBeUndefined()
})

test("only the rules of this project are listed, and rules of other projects are left alone", () => {
  const rules = [
    { project: "/work/app", commandPrefix: "npm test", decision: "allow" },
    { project: "/work/other", commandPrefix: "npm test", decision: "deny" },
    { commandPrefix: "ls", decision: "allow" },
  ]
  expect(projectRules(rules, "/work/app")).toEqual([rules[0]])
})

test("two rules are the same when they say the same about the same prefix of the same project", () => {
  const rule = { project: "/p", commandPrefix: "npm test", decision: "allow" }
  expect(sameRule(rule, { ...rule })).toBe(true)
  expect(sameRule(rule, { ...rule, decision: "deny" })).toBe(false)
  expect(sameRule(rule, { ...rule, project: "/q" })).toBe(false)
})
