import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/infra/project/instance"
import { Session } from "../../src/agent/session"
import { ReadTool } from "../../src/agent/tools/read"
import { GlobTool } from "../../src/agent/tools/glob"
import { Filesystem } from "@merakcode/util/filesystem"
import type { Tool } from "../../src/agent/tools/tool"
import { Plugin } from "../../src/agent/plugin"

test.each(["read", "glob"])("%s applies the current mode after a delayed path plugin", async (kind) => {
  await using tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      await Filesystem.write(path.join(directory, "note.txt"), "READABLE_CONTENT")
      await Filesystem.write(
        path.join(directory, ".merakcode/plugin/guard.ts"),
        `
      import fs from "node:fs/promises"
      import path from "node:path"
      import { setTimeout } from "node:timers/promises"
      export default { id: "delayed-guard", server: async ({ directory }) => ({
        "experimental.tool.path.guard": async (input, output) => {
          const targets = input.paths.filter(file => file.endsWith("note.txt"))
          if (!targets.length) return
          await fs.writeFile(path.join(directory, ".ready"), "ready")
          while (!(await fs.stat(path.join(directory, ".release")).catch(() => undefined))) await setTimeout(10)
          output.denied.push(...targets)
          output.message = "DELAYED_POLICY_DENIAL"
        },
      }) }
    `,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect((await Plugin.statuses()).find((plugin) => plugin.id === "delayed-guard")?.status).toBe("active")
      const session = await Session.create({})
      const ctx: Tool.Context = {
        sessionID: session.id,
        messageID: "",
        agent: "build",
        sessionMode: "execute",
        abort: new AbortController().signal,
        messages: [],
        ruleset: [],
        metadata() {},
        async ask() {},
      }
      const run = async () =>
        kind === "read"
          ? (await ReadTool.init()).execute({ filePath: path.join(tmp.path, "note.txt") }, ctx)
          : (await GlobTool.init()).execute({ pattern: "*.txt", path: tmp.path }, ctx)
      const running = run()
      running.catch(() => {})
      try {
        await expect.poll(() => Filesystem.isFile(path.join(tmp.path, ".ready"))).toBe(true)
        await Session.setMode({ sessionID: session.id, sessionMode: "auto" })
      } finally {
        await fs.writeFile(path.join(tmp.path, ".release"), "release")
      }
      expect((await running).output).toContain(kind === "read" ? "READABLE_CONTENT" : "note.txt")
      await Session.setMode({ sessionID: session.id, sessionMode: "execute" })
      if (kind === "read") await expect(run()).rejects.toThrow("DELAYED_POLICY_DENIAL")
      else expect((await run()).output).not.toContain("note.txt")
    },
  })
})
