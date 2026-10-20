import { describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from "url"
import { Plugin } from "@merakcode/engine/plugin/index"
import { Instance } from "@merakcode/engine/project/instance"
import { ToolRegistry } from "@merakcode/engine/tool/registry"
import { Global } from "@merakcode/engine/global/index"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

async function setup(dir: string) {
  const root = path.join(dir, ".merakcode")
  const plugins = path.join(root, "plugin")
  const modules = path.join(root, "node_modules")
  await fs.mkdir(plugins, { recursive: true })
  await fs.mkdir(modules, { recursive: true })
  await fs.symlink(
    path.dirname(fileURLToPath(import.meta.resolve("zod"))),
    path.join(modules, "zod"),
    process.platform === "win32" ? "junction" : "dir",
  )
  return plugins
}

describe("plugin.runtime", () => {
  test("loads an explicit module server and protects reserved tools", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugins = await setup(dir)
        await Filesystem.write(
          path.join(plugins, "community.ts"),
          [
            'import { z } from "zod"',
            "const definition = {",
            '  description: "community tool",',
            "  args: { value: z.string().optional() },",
            '  execute: async () => "ok",',
            "}",
            "export const community = async () => ({ tool: { community_ping: definition, skill: definition } })",
            'export default { id: "community-module", server: community }',
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("community_ping")
        expect(ids.filter((id) => id === "skill")).toHaveLength(1)

        const status = (await Plugin.statuses()).find((item) => item.id === "community-module")
        expect(status?.status).toBe("active")
        expect(status?.tools).toEqual(["community_ping", "skill"])
      },
    })
  })

  test("each plugin gets its own dataDirectory under Global.Path.data/plugin/<id>", async () => {
    // Report the captured value through a file, not an exported getter: `servers()` treats every named function
    // export as a plugin entry (community plugins often export a bare function), so a getter would load as a second
    // plugin and throw.
    const captureFile = path.join(process.env.TMPDIR ?? "/tmp", `data-dir-probe-${Date.now()}-${Math.random()}.json`)
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugins = await setup(dir)
        await Filesystem.write(
          path.join(plugins, "data-dir-probe.ts"),
          [
            "import fs from 'fs/promises'",
            "export default {",
            '  id: "data-dir-probe",',
            "  server: async (input) => {",
            `    await fs.writeFile(${JSON.stringify(captureFile)}, input.dataDirectory)`,
            "    return {}",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const status = (await Plugin.statuses()).find((item) => item.id === "data-dir-probe")
          expect(status?.status).toBe("active")

          const captured = await fs.readFile(captureFile, "utf-8")
          expect(captured).toBe(path.join(Global.Path.data, "plugin", "data-dir-probe"))
        },
      })
    } finally {
      await fs.rm(captureFile, { force: true })
    }
  })

  test("isolates an invalid plugin while keeping valid plugins active", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugins = await setup(dir)
        await Filesystem.write(path.join(plugins, "broken.ts"), 'export default { id: "broken" }\n')
        await Filesystem.write(
          path.join(plugins, "healthy.ts"),
          'export default { id: "healthy", server: async () => ({}) }\n',
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const statuses = await Plugin.statuses()
        expect(statuses.some((item) => item.id === "healthy" && item.status === "active")).toBe(true)
        expect(statuses.some((item) => item.id === "broken" && item.status === "failed")).toBe(true)
      },
    })
  })
})

/**
 * Plugin tools may return an object, as in opencode 1.16.2:
 * `ToolResult = string | { title?, output, metadata?, attachments? }`. Without this, plugins migrated from opencode
 * would silently lose their title and metadata, and output would become "[object Object]".
 */
describe("plugin tool object results (opencode ToolResult format)", () => {
  async function runTool(dir: string, id: string) {
    // tools() returns initialized entries with execute ready
    const tool = (await ToolRegistry.tools({ providerID: "test-provider", modelID: "test-model" })).find(
      (item) => item.id === id,
    )
    if (!tool) throw new Error(`tool ${id} not registered`)
    return tool.execute({}, {
      sessionID: "ses_p17",
      messageID: "msg_p17",
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      ruleset: [],
      metadata: async () => {},
      // Plugin tools ask for permission on every call; approve right away
      ask: async () => {},
      askExternalDirectory: async () => {},
      extra: { directory: dir },
    } as never)
  }

  test("keeps title, metadata and output of an object result", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugins = await setup(dir)
        await Filesystem.write(
          path.join(plugins, "object-result.ts"),
          [
            'import { z } from "zod"',
            "export default {",
            '  id: "p17-object-result",',
            "  server: async () => ({",
            "    tool: {",
            "      p17_object: {",
            '        description: "returns an object",',
            "        args: {},",
            "        execute: async () => ({",
            '          title: "插件给的标题",',
            '          output: "插件给的输出",',
            "          metadata: { answer: 42 },",
            "        }),",
            "      },",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await runTool(tmp.path, "p17_object")
        expect(result.title).toBe("插件给的标题")
        expect(result.output).toBe("插件给的输出")
        // The engine's truncation flag and the plugin's metadata coexist
        expect(result.metadata).toMatchObject({ answer: 42, truncated: false })
      },
    })
  })

  test("a string result keeps an empty title and the output as is", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugins = await setup(dir)
        await Filesystem.write(
          path.join(plugins, "string-result.ts"),
          [
            'import { z } from "zod"',
            "export default {",
            '  id: "p17-string-result",',
            "  server: async () => ({",
            "    tool: {",
            "      p17_string: {",
            '        description: "returns a string",',
            "        args: {},",
            '        execute: async () => "纯字符串输出",',
            "      },",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await runTool(tmp.path, "p17_string")
        expect(result.title).toBe("")
        expect(result.output).toBe("纯字符串输出")
        expect(result.metadata).toMatchObject({ truncated: false })
      },
    })
  })
})
