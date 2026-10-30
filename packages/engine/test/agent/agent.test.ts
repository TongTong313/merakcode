import { test, expect } from "vitest"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Agent } from "@merakcode/engine/agent/agent"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import type { PermissionMode } from "@merakcode/engine/agent/permission/mode"
import { Loop } from "@merakcode/engine/agent/loop/index"
import type { Session } from "@merakcode/engine/agent/session/index"

/** Uses the real rule chain (Loop.buildToolExecutionRuleset): mode defaults + user config + agent limits. */
function evalPerm(
  agent: Agent.Info | undefined,
  permission: string,
  pattern = "*",
  permissionMode: PermissionMode.Value = "ask",
): PermissionNext.Action | undefined {
  if (!agent) return undefined
  const session = { id: "ses_agent_test", permission: [] } as unknown as Session.Info
  return PermissionNext.evaluate(
    permission,
    pattern,
    Loop.buildToolExecutionRuleset({ agent, session, permissionMode }),
  ).action
}

test("returns default native agents when no config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await Agent.list()
      const names = agents.map((a) => a.name)
      expect(names).toContain("build")
      // Plan mode is a read-only permission mode, not an agent.
      expect(names).not.toContain("plan")
      expect(names).not.toContain("自动模式")
      expect(names).toContain("general")
      expect(names).toContain("explore")
      expect(names).toContain("compaction")
      expect(names).toContain("title")
      expect(names).toContain("summary")
      expect(names).not.toContain("workflow")
    },
  })
})

test("build agent has correct default properties", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      expect(build?.mode).toBe("primary")
      expect(build?.native).toBe(true)
      // Ask mode: workspace edits are written directly (undone later in review); non-read-only commands ask.
      expect(evalPerm(build, "edit")).toBe("allow")
      expect(evalPerm(build, "bash")).toBe("ask")
      expect(build?.profile?.availableTools).toContain("edit")
      expect(build?.profile?.availableTools).toContain("write")
      expect(build?.profile?.availableTools).toContain("multi_edit")
      expect(build?.profile?.availableTools).not.toContain("apply_patch")
    },
  })
})

test("explore agent denies edit and write but allows todo", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeDefined()
      expect(explore?.mode).toBe("subagent")
      for (const key of ["edit", "protected_write", "external_write"]) expect(evalPerm(explore, key), key).toBe("deny")
      // todowrite is an internal protocol and is allowed in every mode.
      expect(evalPerm(explore, "todowrite")).toBe("allow")
    },
  })
})

test("general agent allows todowrite (internal protocol; subsession isolation relies on sessionID)", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const general = await Agent.get("general")
      expect(general).toBeDefined()
      expect(general?.mode).toBe("subagent")
      expect(general?.hidden).toBeUndefined()
      expect(evalPerm(general, "todowrite")).toBe("allow")
    },
  })
})

test("compaction agent only keeps read-only tool permissions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const compaction = await Agent.get("compaction")
      expect(compaction).toBeDefined()
      expect(compaction?.hidden).toBe(true)
      expect(evalPerm(compaction, "bash")).toBe("deny")
      expect(evalPerm(compaction, "edit")).toBe("deny")
      expect(evalPerm(compaction, "read")).toBe("allow")
    },
  })
})

test("custom agent from config creates new agent", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const custom = await Agent.get("my_custom_agent")
      expect(custom).toBeDefined()
      expect(custom?.model?.providerID).toBe("openai")
      expect(custom?.model?.modelID).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    },
  })
})

test("custom agent config overrides native agent properties", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          model: "anthropic/claude-3",
          description: "Custom build agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      expect(build?.model?.providerID).toBe("anthropic")
      expect(build?.model?.modelID).toBe("claude-3")
      expect(build?.description).toBe("Custom build agent")
      expect(build?.temperature).toBe(0.7)
      expect(build?.color).toBe("#FF0000")
      expect(build?.native).toBe(true)
    },
  })
})

test("agent disable removes agent from list", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeUndefined()
      const agents = await Agent.list()
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("explore")
    },
  })
})

test("agent permission config merges with defaults", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          permission: {
            // glob is the probe because webfetch/bash etc. are EXEMPT_PERMISSION_KEYS and drop user permission config.
            glob: "deny",
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      // agent.permission overrides DEFAULT_TOOL_RULES; other tools keep their defaults.
      expect(evalPerm(build, "glob")).toBe("deny")
      expect(evalPerm(build, "read")).toBe("allow")
    },
  })
})

test("global permission config applies to all agents", async () => {
  await using tmp = await tmpdir({
    config: {
      permission: {
        glob: "deny",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      expect(evalPerm(build, "glob")).toBe("deny")
    },
  })
})

test("agent steps/maxSteps config sets steps property", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { steps: 50 },
        simplifier: { maxSteps: 100 },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      const simplifier = await Agent.get("simplifier")
      expect(build?.steps).toBe(50)
      expect(simplifier?.steps).toBe(100)
    },
  })
})

test("agent mode can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { mode: "primary" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore?.mode).toBe("primary")
    },
  })
})

test("agent name can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { name: "Builder" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build?.name).toBe("Builder")
    },
  })
})

test("agent prompt can be set from config", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { prompt: "Custom system prompt" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build?.prompt).toBe("Custom system prompt")
    },
  })
})

test("unknown agent properties are placed into options", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build?.options.random_property).toBe("hello")
      expect(build?.options.another_random).toBe(123)
    },
  })
})

test("agent options merge correctly", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build?.options.custom_option).toBe(true)
      expect(build?.options.another_option).toBe("value")
    },
  })
})

test("multiple custom agents can be defined", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agentA = await Agent.get("agent_a")
      const agentB = await Agent.get("agent_b")
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    },
  })
})

test("Agent.get returns undefined for non-existent agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const nonExistent = await Agent.get("does_not_exist")
      expect(nonExistent).toBeUndefined()
    },
  })
})

test("evaluate matches Windows drive letters case-insensitively (non-bash path patterns are normalized)", () => {
  if (process.platform !== "win32") return
  const ruleset = PermissionNext.fromConfig({ external_read: { "C:/Users/demo/plans/*": "allow" } })
  expect(PermissionNext.evaluate("external_read", "c:/Users/demo/plans/1-a.md", ruleset).action).toBe("allow")
})

test("ask mode defaults: internal protocols allowed, external reads and non-allowlisted network ask", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(evalPerm(build, "doom_loop")).toBe("allow")
      expect(evalPerm(build, "external_read", "/some/other/path")).toBe("ask")
      expect(evalPerm(build, "network", "example.com")).toBe("ask")
      expect(evalPerm(build, "network", "registry.npmjs.org")).toBe("allow")
    },
  })
})

test("legacy tools config converts to permissions", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(evalPerm(build, "bash")).toBe("deny")
      expect(evalPerm(build, "read")).toBe("deny")
    },
  })
})

test("legacy tools config: agent.tools.write=false denies edit", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          tools: {
            write: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(evalPerm(build, "edit")).toBe("deny")
    },
  })
})

test("user deny rules apply from both global and per-agent config", async () => {
  await using tmp = await tmpdir({
    config: {
      permission: { external_read: "deny" },
      agent: { build: { permission: { network: "deny" } } },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      const general = await Agent.get("general")
      expect(evalPerm(build, "external_read", "/some/other/path")).toBe("deny")
      expect(evalPerm(general, "external_read", "/some/other/path")).toBe("deny")
      expect(evalPerm(build, "network", "registry.npmjs.org")).toBe("deny")
      expect(evalPerm(general, "network", "registry.npmjs.org")).toBe("allow")
    },
  })
})

test("user path rules allow one directory outside the workspace while the rest still ask", async () => {
  await using tmp = await tmpdir({
    config: { permission: { external_read: { "~/docs/*": "allow" } } },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      const os = await import("os")
      expect(
        evalPerm(build, "external_read", PermissionNext.normalizePath(path.join(os.homedir(), "docs", "a.md"))),
      ).toBe("allow")
      expect(evalPerm(build, "external_read", PermissionNext.normalizePath(path.join(os.homedir(), "a.md")))).toBe(
        "ask",
      )
    },
  })
})

test("defaultAgent returns build when no default_agent config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.defaultAgent()
      expect(agent).toBe("build")
    },
  })
})

test("defaultAgent respects default_agent config set to custom agent with mode all", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "my_custom",
      agent: {
        my_custom: {
          description: "My custom agent",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.defaultAgent()
      expect(agent).toBe("my_custom")
    },
  })
})

test("defaultAgent throws when default_agent points to subagent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "explore",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Agent.defaultAgent()).rejects.toThrow('default agent "explore" is a subagent')
    },
  })
})

test("defaultAgent throws when default_agent points to hidden agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "compaction",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Agent.defaultAgent()).rejects.toThrow('default agent "compaction" is hidden')
    },
  })
})

test("defaultAgent throws when default_agent points to non-existent agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "does_not_exist",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Agent.defaultAgent()).rejects.toThrow('default agent "does_not_exist" not found')
    },
  })
})

test("auto mode: build edits files, dotfiles and runs commands without asking; risky commands and external writes still ask", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      for (const key of ["edit", "protected_write", "bash", "bash_delete", "read", "todowrite"])
        expect(evalPerm(build, key, "*", "auto"), key).toBe("allow")
      expect(evalPerm(build, "bash_risky", "git push", "auto")).toBe("ask")
      expect(evalPerm(build, "external_write", "/etc/hosts", "auto")).toBe("ask")
    },
  })
})

test("auto mode: simplifier edits without asking and question stays denied", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const simplifier = await Agent.get("simplifier")
      expect(simplifier).toBeDefined()
      expect(evalPerm(simplifier, "edit", "*", "auto")).toBe("allow")
      // restrictedRules force-deny question, which auto mode cannot override; the runner drops the tool instead.
      expect(evalPerm(simplifier, "question", "*", "auto")).toBe("deny")
    },
  })
})

test("defaultAgent returns the next visible primary agent when build is disabled", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.defaultAgent()
      // Plan is a permission mode, not an agent, so the next primary agent after build is simplifier.
      expect(agent).toBe("simplifier")
    },
  })
})

test("defaultAgent throws when all primary agents are disabled", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { disable: true },
        simplifier: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Agent.defaultAgent()).rejects.toThrow("no primary visible agent found")
    },
  })
})

test("auto mode still applies user deny rules", async () => {
  await using tmp = await tmpdir({
    config: {
      permission: {
        edit: { "*.lock": "deny" },
        bash: { "docker *": "deny" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      expect(evalPerm(build, "edit", "/work/pnpm.lock", "auto")).toBe("deny")
      expect(evalPerm(build, "edit", "/work/a.ts", "auto")).toBe("allow")
      expect(evalPerm(build, "bash", "docker run x", "auto")).toBe("deny")
      expect(evalPerm(build, "bash", "npm test", "auto")).toBe("allow")
    },
  })
})

test("explore agent: write/edit are forced deny, read tools are forced allow", async () => {
  await using tmp = await tmpdir({
    config: {
      permission: {
        edit: "allow",
        external_write: "allow",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeDefined()
      expect(evalPerm(explore, "edit")).toBe("deny")
      expect(evalPerm(explore, "external_write")).toBe("deny")
      expect(evalPerm(explore, "read")).toBe("allow")
      expect(evalPerm(explore, "grep")).toBe("allow")
    },
  })
})

test("build agent: user config cannot override plan_* internal keys but can override question", async () => {
  await using tmp = await tmpdir({
    config: {
      permission: {
        question: "deny",
        plan_enter: "deny",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      expect(evalPerm(build, "question")).toBe("deny")
      // plan_enter is in INTERNAL_PERMISSION_KEYS, so user config is filtered out and the mode default applies.
      expect(evalPerm(build, "plan_enter")).toBe("allow")
    },
  })
})

test("general and simplifier have the expected profile.restrictedRules", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const general = await Agent.get("general")
      const simplifier = await Agent.get("simplifier")
      expect(general?.profile?.restrictedRules.length).toBe(0)
      expect(simplifier?.profile?.restrictedRules.some((r) => r.permission === "question")).toBe(true)
    },
  })
})

test("builtin agents have the expected profile.restrictedRules", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        "my-custom-agent": { mode: "all" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      const explore = await Agent.get("explore")
      const br = build?.profile?.restrictedRules ?? []
      expect(br).toEqual([])
      expect(explore?.profile?.restrictedRules.some((r) => r.permission === "edit" && r.action === "deny")).toBe(true)
      const custom = await Agent.get("my-custom-agent")
      expect(custom?.profile?.restrictedRules ?? []).toEqual([])
    },
  })
})
