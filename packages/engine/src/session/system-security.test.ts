import { describe, expect, test } from "vitest"
import { SystemPrompt } from "./system"

const agent = (availableTools?: string[]) => ({
  ...(availableTools
    ? {
        profile: {
          availableTools,
        },
      }
    : {}),
})

describe("secure coding system prompt", () => {
  test("covers TLS verification and safe private CA handling", () => {
    const prompt = SystemPrompt.secureCoding(agent(["write"]))[0] ?? ""

    expect(prompt).toContain("ssl.CERT_NONE")
    expect(prompt).toContain("check_hostname = False")
    expect(prompt).toContain("verify=False")
    expect(prompt).toContain("rejectUnauthorized: false")
    expect(prompt).toContain("ssl.create_default_context()")
    expect(prompt).toContain("explicit user-provided CA")
    expect(prompt).toContain("hostname mismatch")
  })

  test("covers canonical path containment and traversal regressions", () => {
    const prompt = SystemPrompt.secureCoding(agent(["edit"]))[0] ?? ""

    expect(prompt).toContain("os.path.commonpath()")
    expect(prompt).toContain("Path.is_relative_to()")
    expect(prompt).toContain("Never use string `startswith()`")
    expect(prompt).toContain("%2e%2e")
    expect(prompt).toContain("double-encoded traversal")
    expect(prompt).toContain("sibling-prefix collisions")
    expect(prompt).toContain("symlink escapes")
    expect(prompt).toContain("127.0.0.1")
  })

  test("requires same-turn review, focused tests, repair, and rerun", () => {
    const prompt = SystemPrompt.secureCoding(agent(["bash"]))[0] ?? ""

    expect(prompt).toContain("Before declaring a code-changing task complete")
    expect(prompt).toContain("every file changed in this turn")
    expect(prompt).toContain("add focused regression tests")
    expect(prompt).toContain("fix failures, and rerun them")
  })

  test("injects for default and custom code-capable agents", () => {
    expect(SystemPrompt.secureCoding(agent())).toHaveLength(1)
    expect(SystemPrompt.secureCoding(agent(["write"]))).toHaveLength(1)
    expect(SystemPrompt.secureCoding(agent(["bash"]))).toHaveLength(1)
    expect(SystemPrompt.secureCoding(agent(["subagent"]))).toHaveLength(1)
  })

  test("does not burden read-only and internal helper agents", () => {
    expect(SystemPrompt.secureCoding(agent([]))).toEqual([])
    expect(SystemPrompt.secureCoding(agent(["read", "glob", "grep"]))).toEqual([])
  })
})
