import { afterEach, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import type { Tool as AITool } from "ai"
import type { Provider } from "@merakcode/engine/provider/provider"
import { Config } from "@merakcode/engine/config/config"
import { Instance } from "@merakcode/engine/project/instance"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Session } from "@merakcode/engine/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { SessionProcessor } from "@merakcode/engine/session/processor"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/session/message"
import { PermissionNext } from "@merakcode/engine/permission/next"
import { Bus } from "@merakcode/engine/bus/index"
import { tmpdir } from "../fixture/fixture"

const originalHome = process.env.MERAKCODE_TEST_HOME

afterEach(() => {
  process.env.MERAKCODE_TEST_HOME = originalHome
})

/** Makes the directory string differ from the git worktree, which used to let the upward scan escape the repo root. */
function ideDirectory(dir: string) {
  const canonical = Filesystem.canonicalDirectory(dir)
  if (canonical !== dir) return canonical
  return `${canonical}${path.sep}.`
}

test("child git project does not inherit permission from $HOME/.merakcode", async () => {
  await using home = await tmpdir({
    init: async (dir) => {
      const ghost = path.join(dir, ".merakcode")
      await fs.mkdir(ghost)
      await Filesystem.write(
        path.join(ghost, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: { write: "allow", edit: "allow" },
        }),
      )
      const child = path.join(dir, "child")
      await fs.mkdir(child)
      await Process.run(["git", "init"], { cwd: child })
      await Process.run(["git", "config", "user.name", "MerakCode Test"], { cwd: child })
      await Process.run(["git", "config", "user.email", "merakcode-test@example.com"], { cwd: child })
      await Process.run(["git", "commit", "--allow-empty", "-m", "root"], { cwd: child })
      return child
    },
  })

  process.env.MERAKCODE_TEST_HOME = home.path

  await Instance.provide({
    directory: ideDirectory(home.extra),
    fn: async () => {
      const config = await Config.get()
      expect(config.permission?.write).not.toBe("allow")
      expect(config.permission?.edit).not.toBe("allow")
      const dirs = await Config.directories()
      expect(dirs.some((dir) => Filesystem.sameDirectory(dir, path.join(home.path, ".merakcode")))).toBe(false)
    },
  })
})

test("loads $HOME/.merakcode when home itself is the project", async () => {
  await using home = await tmpdir({
    git: true,
    init: async (dir) => {
      const ghost = path.join(dir, ".merakcode")
      await fs.mkdir(ghost)
      await Filesystem.write(
        path.join(ghost, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: { write: "allow", edit: "allow" },
        }),
      )
    },
  })

  process.env.MERAKCODE_TEST_HOME = home.path

  await Instance.provide({
    directory: home.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.permission?.write).toBe("allow")
      expect(config.permission?.edit).toBe("allow")
    },
  })
})

test("ancestor .merakcode inside the repo is still merged into subdirectories", async () => {
  await using repo = await tmpdir({
    git: true,
    init: async (dir) => {
      const nested = path.join(dir, ".merakcode")
      await fs.mkdir(nested)
      await Filesystem.write(
        path.join(nested, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: { write: "allow" },
        }),
      )
      const pkg = path.join(dir, "pkg")
      await fs.mkdir(pkg)
      return pkg
    },
  })

  await Instance.provide({
    directory: repo.extra,
    fn: async () => {
      const config = await Config.get()
      expect(config.permission?.write).toBe("allow")
    },
  })
})

test("non-git subdirectory does not inherit permission from $HOME/.merakcode when home is a git repo", async () => {
  await using home = await tmpdir({
    git: true,
    init: async (dir) => {
      const ghost = path.join(dir, ".merakcode")
      await fs.mkdir(ghost)
      await Filesystem.write(
        path.join(ghost, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: { write: "allow", edit: "allow" },
        }),
      )
      const child = path.join(dir, "child")
      await fs.mkdir(child)
      return child
    },
  })

  process.env.MERAKCODE_TEST_HOME = home.path

  await Instance.provide({
    directory: home.extra,
    fn: async () => {
      expect(Filesystem.sameDirectory(Instance.worktree, home.path)).toBe(true)
      const config = await Config.get()
      expect(config.permission?.write).not.toBe("allow")
      expect(config.permission?.edit).not.toBe("allow")
    },
  })
})

const probeModel = {
  id: "gpt-4",
  providerID: "openai",
  modelID: "gpt-4",
  api: { id: "gpt-4" },
} as unknown as Provider.Model

function executeTool(tool: AITool | undefined, args: Record<string, unknown>) {
  expect(tool).toBeDefined()
  expect(tool!.execute).toBeDefined()
  return tool!.execute!(args, {
    toolCallId: Identifier.ascending("part"),
    abortSignal: new AbortController().signal,
    messages: [],
    context: {},
  })
}

test("with auto mode off, stray home config does not leak into a subdirectory (write neither asks nor is denied)", async () => {
  await using home = await tmpdir({
    git: true,
    init: async (dir) => {
      const ghost = path.join(dir, ".merakcode")
      await fs.mkdir(ghost)
      await Filesystem.write(
        path.join(ghost, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: { write: "deny", edit: "deny" },
        }),
      )
      const child = path.join(dir, "child")
      await fs.mkdir(child)
      return child
    },
  })

  process.env.MERAKCODE_TEST_HOME = home.path
  const child = home.extra

  await Instance.provide({
    directory: ideDirectory(child),
    fn: async () => {
      const session = await Session.setPermissionMode({
        sessionID: (await Session.create({})).id,
        permissionMode: "ask",
      })
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        permissionMode: "ask",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })
      const agent = await Agent.get("build")
      expect(agent).toBeDefined()
      const assistantInfo = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID: session.id,
        mode: "build",
        agent: "build",
        path: { cwd: child, root: child },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: probeModel.id,
        providerID: probeModel.providerID,
        parentID: user.id,
        time: { created: Date.now() },
      })) as Message.AssistantInfo
      const processor = SessionProcessor.create({
        assistantInfo,
        sessionID: session.id,
        model: probeModel,
        abort: new AbortController().signal,
      })
      const live = await Session.get(session.id)
      const { tools } = await SessionRunner.resolveTools({
        agent: agent!,
        model: probeModel,
        session: live,
        processor,
        bypassAgentCheck: false,
        messages: [{ info: user, parts: [] }],
        permissionMode: "ask",
      })

      // The stray config in $HOME/.merakcode must not be inherited by the subdirectory. Write no longer asks by
      // default, so the stricter check is that its `write: "deny"` is not applied: the write must succeed without
      // a permission prompt.
      const filePath = path.join(child, "ghost-not-inherited.txt")
      let asked = false
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => {
        asked = true
      })
      try {
        await executeTool(tools.write, { filePath, content: "x" }).catch(() => undefined)
      } finally {
        unsub()
      }
      expect(asked).toBe(false)
      expect(await Filesystem.readText(filePath)).toBe("x")
    },
  })
})
