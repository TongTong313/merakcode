// bash.txt may be shortened or rewritten, but its safety guardrails must not be lost. Prompt changes like that are not
// caught by typecheck or unit tests, so this only guards the most basic layer: the safety keywords must still be
// present. Real behavior still needs a manual run of git commit / PR creation, comparing the model before and after.
import { describe, expect, test } from "vitest"
import BASH_DESCRIPTION from "./bash.txt"

describe("bash.txt safety guardrail keywords", () => {
  test("keeps the key Git Safety Protocol rules", () => {
    expect(BASH_DESCRIPTION).toContain("NEVER update the git config")
    expect(BASH_DESCRIPTION).toContain("force push")
    expect(BASH_DESCRIPTION).toContain("pre-commit hook")
    expect(BASH_DESCRIPTION).toContain("NEVER commit changes unless the user explicitly asks")
  })

  test("keeps the guidance for commands the user stopped", () => {
    expect(BASH_DESCRIPTION).toContain("manually stopped this command")
  })
})
