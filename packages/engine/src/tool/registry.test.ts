// Tools outside the agent's pool must skip t.init() in tools(), since SessionRunner.resolveTools() would drop them
// anyway. Without an agent (`GET /tool` in server/routes/experimental.ts) the full catalog is still returned.
import { describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from "url"
import z from "zod"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { ReadTool } from "./read"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import { Plugin } from "../plugin"
import type { Agent } from "../agent/agent"
import { tmpdir } from "../../test/fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

const model = { providerID: "anthropic", modelID: "claude-test" }

function fakeTool(id: string, onInit: () => void) {
  return Tool.define(id, async () => {
    onInit()
    return {
      description: "test tool for registry pool-filter regression",
      parameters: z.object({}),
      async execute() {
        return { title: "", metadata: {}, output: "" }
      },
    }
  })
}

// ToolRegistry.register()/tools() read Instance.directory through Instance.state(), so they must run inside the
// AsyncLocalStorage context of Instance.provide(). Each test uses its own temporary directory so the per-directory
// Instance cache does not leak between tests.
async function withInstance<T>(fn: (directory: string) => Promise<T>, init?: (directory: string) => Promise<void>) {
  await using dir = await tmpdir({ init, dispose: (dir) => fs.rm(dir, { recursive: true, force: true }) })
  return await Instance.provide({
    directory: dir.path,
    fn: async () => {
      try {
        return await fn(dir.path)
      } finally {
        await Config.waitForDependencies()
        await Instance.dispose()
      }
    },
  })
}

describe("ToolRegistry.tools() agent pool filtering", () => {
  test("skips init() when agent.profile.availableTools lacks the tool id", async () => {
    let calls = 0
    await withInstance(async () => {
      await ToolRegistry.register(fakeTool("zzz_test_pool_excluded", () => calls++))
      const agent = {
        id: "narrow",
        profile: { availableTools: ["read"], restrictedRules: [] },
      } as unknown as Agent.Info
      await ToolRegistry.tools(model, agent)
    })
    expect(calls).toBe(0)
  })

  test("calls init() when agent.profile.availableTools includes the tool id", async () => {
    let calls = 0
    await withInstance(async () => {
      await ToolRegistry.register(fakeTool("zzz_test_pool_included", () => calls++))
      const agent = {
        id: "wide",
        profile: { availableTools: ["zzz_test_pool_included"], restrictedRules: [] },
      } as unknown as Agent.Info
      await ToolRegistry.tools(model, agent)
    })
    expect(calls).toBe(1)
  })

  test("initializes dynamic tools when agent.profile.availableTools includes the plugin capability", async () => {
    let calls = 0
    await withInstance(async () => {
      await ToolRegistry.register(fakeTool("zzz_test_plugin_capability", () => calls++))
      const agent = {
        id: "plugin-enabled",
        profile: { availableTools: ["plugin"], restrictedRules: [] },
      } as unknown as Agent.Info
      const tools = await ToolRegistry.tools(model, agent)
      expect(tools.some((tool) => tool.id === "zzz_test_plugin_capability")).toBe(true)
    })
    expect(calls).toBe(1)
  })

  test("initializes invalid even when it is not in the tool pool", async () => {
    await withInstance(async () => {
      const agent = {
        id: "narrow",
        profile: { availableTools: ["read"], restrictedRules: [] },
      } as unknown as Agent.Info
      const tools = await ToolRegistry.tools(model, agent)
      expect(tools.some((tool) => tool.id === "invalid")).toBe(true)
    })
  })

  test("returns the full catalog when no agent is passed", async () => {
    let calls = 0
    await withInstance(async () => {
      await ToolRegistry.register(fakeTool("zzz_test_pool_no_agent", () => calls++))
      await ToolRegistry.tools(model)
    })
    expect(calls).toBe(1)
  })
})

describe("ToolRegistry trusted origin", () => {
  const agent = {
    id: "origin-test",
    profile: { availableTools: ["read", "plugin"], restrictedRules: [] },
  } as unknown as Agent.Info

  test("register cannot claim a builtin origin through tool fields or initialization results", async () => {
    await withInstance(async () => {
      const tool = Object.assign(
        Tool.define("read", async () => ({
          origin: "builtin" as const,
          description: "registered custom read",
          parameters: z.object({}),
          async execute() {
            return { title: "", metadata: { origin: "builtin" }, output: "registered" }
          },
        })),
        { origin: "builtin", metadata: { origin: "builtin" } },
      )
      await ToolRegistry.register(tool)
      const reads = (await ToolRegistry.tools(model, agent)).filter((item) => item.id === "read")
      expect(reads.map((item) => item.origin)).toEqual(["builtin", "custom"])
      expect(reads[1].description).toBe("registered custom read")
      expect((await ToolRegistry.ids()).filter((id) => id === "read")).toHaveLength(2)
      expect(await ToolRegistry.dynamicIds()).toContain("read")

      await ToolRegistry.register({
        ...tool,
        init: async () => ({ ...(await tool.init()), description: "replacement" }),
      })
      const replaced = (await ToolRegistry.tools(model, agent)).filter((item) => item.id === "read")
      expect(replaced.map((item) => item.origin)).toEqual(["builtin", "custom"])
      expect(replaced[1].description).toBe("replacement")
    })
  })

  test("registering the same builtin object still creates a custom entry", async () => {
    await withInstance(async () => {
      await ToolRegistry.register(ReadTool)
      await ToolRegistry.register(ReadTool)
      const reads = (await ToolRegistry.tools(model, agent)).filter((item) => item.id === "read")
      expect(reads.map((item) => item.origin)).toEqual(["builtin", "custom"])
      expect(reads[0].parameters).toBe(reads[1].parameters)
      expect("origin" in ReadTool).toBe(false)
    })
  })

  test("local same-name tools and plugin tools remain custom after real plugin hooks", async () => {
    await withInstance(
      async () => {
        const tools = await ToolRegistry.tools(model, agent)
        const reads = tools.filter((item) => item.id === "read")
        expect(reads.map((item) => item.origin)).toEqual(["builtin", "custom"])
        expect(reads[1].description).toBe("local custom read [hook]")
        expect(reads[0].description).toSatisfy((value: string) => value.endsWith(" [hook]"))
        const custom = tools.find((item) => item.id === "builtin_read")!
        expect(custom.origin).toBe("custom")
        expect(custom.description).toBe("plugin custom read [hook]")
        const status = (await Plugin.statuses()).find((item) => item.id === "origin-plugin")!
        expect(status.status).toBe("active")
        expect(status.tools).toEqual(["builtin_read", "read"])

        const requests: string[] = []
        const context: Tool.Context = {
          sessionID: "origin-session",
          messageID: "origin-message",
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          ruleset: [],
          metadata() {},
          async ask(input) {
            requests.push(input.permission)
          },
        }
        expect((await reads[1].execute({}, context)).output).toBe("local")
        expect((await custom.execute({}, context)).output).toBe("plugin")
        expect(requests).toEqual(["read", "builtin_read"])
      },
      async (directory) => {
        const root = path.join(directory, ".merakcode")
        const modules = path.join(root, "node_modules")
        await fs.mkdir(modules, { recursive: true })
        await fs.symlink(
          path.dirname(fileURLToPath(import.meta.resolve("zod"))),
          path.join(modules, "zod"),
          process.platform === "win32" ? "junction" : "dir",
        )
        await Filesystem.write(
          path.join(root, "tool", "read.ts"),
          `
export default {
  origin: "builtin",
  description: "local custom read",
  args: {},
  execute: async () => "local",
}
`,
        )
        await Filesystem.write(
          path.join(root, "plugin", "origin.ts"),
          `
const definition = {
  origin: "builtin",
  description: "plugin custom read",
  args: {},
  execute: async () => "plugin",
}
export default {
  id: "origin-plugin",
  server: async () => ({
    tool: { builtin_read: definition, read: definition },
    "tool.definition": async (_input, output) => {
      output.origin = "builtin"
      output.description += " [hook]"
    },
  }),
}
`,
        )
      },
    )
  })
})
