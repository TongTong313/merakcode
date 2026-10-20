import { describe, expect, test } from "vitest"
import { ACP } from "../../src/cli/acp/agent"
import type { Agent as ACPAgent } from "@agentclientprotocol/sdk"

/**
 * Type-level test: This line will fail to compile if ACP.Agent
 * doesn't properly implement the ACPAgent interface.
 *
 * The SDK checks for methods like `agent.listSessions` at runtime
 * and throws "Method not found" if they're missing. TypeScript allows optional
 * interface methods to be omitted, but the SDK still expects them.
 *
 * @see https://github.com/agentclientprotocol/typescript-sdk/commit/7072d3f
 */
;({}) as ACP.Agent satisfies ACPAgent

/**
 * Runtime verification that optional methods the SDK expects are actually implemented.
 * The SDK's router checks `if (!agent.methodName)` and throws MethodNotFound if missing.
 */
describe("acp.agent interface compliance", () => {
  // Extract method names from the ACPAgent interface type
  type ACPAgentMethods = keyof ACPAgent

  // Methods that the SDK's router explicitly checks for at runtime
  const sdkCheckedMethods: ACPAgentMethods[] = [
    // Required
    "initialize",
    "newSession",
    "prompt",
    "cancel",
    // Optional but checked by SDK router
    "loadSession",
    "setSessionMode",
    "authenticate",
    "setSessionConfigOption",
    "extMethod",
    "extNotification",
    // initialize advertises list/resume/fork in sessionCapabilities
    "listSessions",
    "resumeSession",
    // Unstable - SDK checks these with unstable_ prefix
    "unstable_forkSession",
  ]

  test("Agent implements all SDK-checked methods", () => {
    for (const method of sdkCheckedMethods) {
      expect(typeof ACP.Agent.prototype[method as keyof typeof ACP.Agent.prototype], `Missing method: ${method}`).toBe(
        "function",
      )
    }
  })
})
