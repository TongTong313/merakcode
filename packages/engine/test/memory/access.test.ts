import { describe, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { Agent } from "@merakcode/engine/agent/agent"
import { MemoryAccess } from "@merakcode/engine/memory/access"
import { MemoryExtract } from "@merakcode/engine/memory/extract"
import { MemoryPath } from "@merakcode/engine/memory/path"
import { PermissionNext } from "@merakcode/engine/permission/next"
import { Instance } from "@merakcode/engine/project/instance"
import { Message } from "@merakcode/engine/session/message"
import { ReadTool } from "@merakcode/engine/tool/read"
import { Tool } from "@merakcode/engine/tool/tool"
import { WriteTool } from "@merakcode/engine/tool/write"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { isProjectFileBypass } from "@merakcode/engine/tool/file-bypass"

function ctx(): Tool.Context {
  return {
    sessionID: "session",
    messageID: "message",
    callID: "call",
    agent: "build",
    kind: "ask",
    abort: AbortSignal.any([]),
    messages: [],
    ruleset: [],
    metadata: () => {},
    ask: async () => {
      throw new Error("ask should not be called for memory paths")
    },
  }
}

function completedTool(tool: string, input: Record<string, unknown>): Message.ToolPart {
  return {
    id: "part",
    messageID: "assistant",
    sessionID: "session",
    type: "tool",
    callID: "call",
    tool,
    state: {
      status: "completed",
      input,
      title: tool,
      output: "ok",
      metadata: {},
      time: { start: 0, end: 1 },
    },
  }
}

describe("MemoryAccess", () => {
  test("separates readable memory paths from writable memory files", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = MemoryPath.directory()
        expect(MemoryAccess.isReadablePath(root)).toBe(true)
        expect(MemoryAccess.isReadablePath(path.join(root, "feedback", "testing.md"))).toBe(true)
        expect(MemoryAccess.isReadablePath(path.join(root, "..", "escape.md"))).toBe(false)
        expect(MemoryAccess.isReadablePath(path.join(tmp.path, "src", "index.ts"))).toBe(false)

        expect(MemoryAccess.isWritablePath(MemoryPath.entrypoint())).toBe(true)
        expect(MemoryAccess.isWritablePath(path.join(root, "feedback", "testing.md"))).toBe(true)
        expect(MemoryAccess.isWritablePath(path.join(root, "feedback", "nested", "testing.md"))).toBe(true)
        expect(MemoryAccess.isWritablePath(path.join(root, "feedback", "testing.json"))).toBe(false)
        expect(MemoryAccess.isWritablePath(path.join(root, "topic.md"))).toBe(false)
        expect(MemoryAccess.isWritablePath(path.join(root, "dreams", "daily.md"))).toBe(false)
      },
    })
  })

  test("memory directory has no special external_directory allow; file-bypass grants access instead", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        expect(build).toBeDefined()
        const target = path.join(MemoryPath.directory(), "feedback", "*")
        // Builtin agents carry no external_directory allow, so only the catch-all ask applies.
        expect(PermissionNext.evaluate("external_directory", target, build!.permission).action).toBe("ask")
        // Memory access goes through file-bypass (isProjectFileBypass -> MemoryAccess.isReadablePath), not rules.
        expect(MemoryAccess.isReadablePath(path.join(MemoryPath.directory(), "feedback", "testing.md"))).toBe(true)
      },
    })
  })

  test("defines a narrow hidden memory extractor agent", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("memory-extractor")
        expect(agent).toBeDefined()
        expect(agent!.hidden).toBe(true)
        expect(agent!.profile?.availableTools).toEqual(["read", "glob", "grep", "ls", "write", "edit", "multi_edit"])
        expect(agent!.profile?.availableTools).not.toContain("bash")
        expect(agent!.profile?.availableTools).not.toContain("subagent")
      },
    })
  })
})

describe("MemoryExtract", () => {
  test("restricts extractor writes to memory while keeping read tools available", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rules = MemoryExtract.permissions()
        const memoryFile = path.join(MemoryPath.typeDir("feedback"), "testing.md")
        const memoryIndex = MemoryPath.entrypoint()
        const rootTopicFile = path.join(MemoryPath.directory(), "topic.md")
        const nonMarkdownFile = path.join(MemoryPath.typeDir("feedback"), "testing.json")
        const projectFile = path.join(tmp.path, "src", "index.ts")

        // Rules allow workspace reads and deny writes, commands and external reads.
        expect(PermissionNext.evaluate("read", projectFile, rules).action).toBe("allow")
        for (const key of ["edit", "protected_write", "external_write", "bash", "external_read"])
          expect(PermissionNext.evaluate(key, projectFile, rules).action, key).toBe("deny")
        // Memory files skip approval, but only .md files under memory type directories and the index.
        const writable = (filePath: string) =>
          isProjectFileBypass({ agent: "memory-extractor", filePath, access: "write" })
        expect(await writable(memoryFile)).toBe(true)
        expect(await writable(memoryIndex)).toBe(true)
        expect(await writable(rootTopicFile)).toBe(false)
        expect(await writable(nonMarkdownFile)).toBe(false)
        expect(await writable(projectFile)).toBe(false)
      },
    })
  })

  test("detects completed tool writes into memory", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const memoryFile = path.join(MemoryPath.typeDir("feedback"), "testing.md")
        const rootTopicFile = path.join(MemoryPath.directory(), "topic.md")
        const projectFile = path.join(tmp.path, "src", "index.ts")

        expect(MemoryExtract.hasMemoryWriteParts([completedTool("write", { filePath: memoryFile })])).toBe(true)
        expect(MemoryExtract.hasMemoryWriteParts([completedTool("write", { filePath: rootTopicFile })])).toBe(false)
        expect(MemoryExtract.hasMemoryWriteParts([completedTool("write", { filePath: projectFile })])).toBe(false)
      },
    })
  })

  test("prompt excludes auto-dream behavior", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const text = await MemoryExtract.prompt()
        expect(text).toContain("Automatic memory extraction")
        expect(text).toContain("Do not create daily logs, dreams, rollups, summaries, or auto-dream artifacts.")
        expect(text).toContain("Reference memories require a concrete external locator")
        expect(text).toContain("Never save local docs, plans, architecture guides")
      },
    })
  })
})

describe("memory tool bypass", () => {
  test("write and read do not ask on memory paths", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(MemoryPath.typeDir("feedback"), "testing.md")
        await fs.mkdir(path.dirname(file), { recursive: true })

        const write = await WriteTool.init()
        await write.execute({ filePath: file, content: "memory content\n" }, ctx())
        expect(await Filesystem.readText(file)).toBe("memory content\n")

        const read = await ReadTool.init()
        const result = await read.execute({ filePath: file }, ctx())
        expect(result.output).toContain("memory content")
      },
    })
  })

  test("write asks for non-writable files under the memory root", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(MemoryPath.directory(), "dreams", "daily.md")
        await fs.mkdir(path.dirname(file), { recursive: true })

        const write = await WriteTool.init()
        // Non-writable memory paths skip the bypass and reach ctx.ask; the fixture's ask throws to prove it was called.
        await expect(write.execute({ filePath: file, content: "daily log\n" }, ctx())).rejects.toThrow(
          "ask should not be called for memory paths",
        )
      },
    })
  })
})
