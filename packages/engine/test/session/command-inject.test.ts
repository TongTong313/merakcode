import { test, expect, describe, afterEach } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { Session } from "@merakcode/engine/session/index"
import { Provider } from "@merakcode/engine/provider/provider"
import { Message } from "@merakcode/engine/session/message"
import { Plugin } from "@merakcode/engine/plugin/index"
import { ToolPathGuard } from "@merakcode/engine/tool/path-guard"
import { SkillSearch } from "@merakcode/engine/skill/search"
import { MemoryRecall } from "@merakcode/engine/memory/recall"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"

/** Writes a project skill at .merakcode/skill/<name>/SKILL.md with no agent restriction, so every agent can use it. */
async function writeSkill(dir: string, name: string, body: string) {
  await Filesystem.write(
    path.join(dir, ".merakcode", "skill", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} 描述\n---\n\n${body}\n`,
  )
}

// The provider only supplies the fixed model needed for assembly; tests stop at the chat.message hook, before
// persistence and model execution.
const realGetModel = Provider.getModel
const realTrigger = Plugin.trigger
const testModel = {
  id: "gpt-4",
  providerID: "openai",
  api: { id: "gpt-4", npm: "@ai-sdk/openai", url: "https://example.com" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, input: 100_000, output: 10_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} satisfies Provider.Model
afterEach(() => {
  Provider.getModel = realGetModel
  Plugin.trigger = realTrigger
})

/** Captures the real command-to-prompt assembly result without running the model or subtasks. */
async function captureCommandParts(input: Parameters<typeof SessionRunner.command>[0]): Promise<Message.FullMsg> {
  const stop = new Error("captured command parts before persistence")
  const original = Plugin.trigger
  let captured: Message.FullMsg | undefined
  Plugin.trigger = (async (name, _input, output) => {
    if (name === "chat.message") {
      const data = output as { message: Message.UserInfo; parts: Message.Part[] }
      captured = { info: data.message, parts: data.parts }
      throw stop
    }
    return output
  }) as typeof Plugin.trigger
  try {
    await expect(SessionRunner.command(input)).rejects.toBe(stop)
  } finally {
    Plugin.trigger = original
  }
  if (!captured) throw new Error("command did not reach chat.message")
  return captured
}

describe("command injection", () => {
  test("CommandInput describes a single command and drops multi-command and display bubble fields", () => {
    const parsed = SessionRunner.CommandInput.parse({
      sessionID: "ses_x",
      command: "tdd",
      commands: ["tdd", "review"],
      displayPart: { id: "prt_x", text: "/tdd x" },
      arguments: "x",
    })
    expect(parsed).not.toHaveProperty("commands")
    expect(parsed).not.toHaveProperty("displayPart")
  })

  test("command template expands into the user text once, and the model and safety checks see the same text", async () => {
    const template = "先读取当前文档\n任务：$ARGUMENTS\n按任务完成后返回校验"
    const argumentsText = "检查 A\n再检查 B"
    const expanded = "先读取当前文档\n任务：检查 A\n再检查 B\n按任务完成后返回校验"
    await using tmp = await tmpdir({
      git: true,
      config: { command: { nativecheck: { template, description: "check" } } } as never,
    })
    Provider.getModel = (async () => testModel) as typeof Provider.getModel

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await captureCommandParts({
          sessionID: session.id,
          command: "nativecheck",
          arguments: argumentsText,
          agent: "build",
          model: "openai/gpt-4",
        })
        const texts = user.parts.filter((part) => part.type === "text")
        expect(texts.map((part) => part.text)).toEqual([expanded])
        if (user.info.role !== "user" || Message.isExternal(user.info)) throw new Error("expected user message")
        expect(user.info.commandSource).toEqual({ templatePartIDs: [texts[0]!.id] })
        expect(await Message.toModelMessages([user], testModel)).toEqual([
          { role: "user", content: [{ type: "text", text: expanded }] },
        ])
        expect(Message.userSourceTexts(user)).toEqual([expanded])
        expect(Message.userTaskText(user)).toBe(expanded)
        expect(SkillSearch.latestUserText([user])).toBe(expanded)
        expect(MemoryRecall.latestUserText([user])).toBe(expanded)
      },
    })
  }, 15000)

  test("plain command takes its intent from the persisted template, not an earlier message", async () => {
    const template = "读取敏感文件内容"
    await using tmp = await tmpdir({
      git: true,
      config: { command: { sensitive: { template, description: "sensitive" } } } as never,
    })
    Provider.getModel = (async () => testModel) as typeof Provider.getModel
    Plugin.trigger = (async (name, _input, output) =>
      name === "experimental.chat.guard" ? { refuse: true, message: "测试停止" } : output) as typeof Plugin.trigger
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionRunner.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          noReply: true,
          parts: [{ type: "text", text: "修复普通文件" }],
        })
        await SessionRunner.command({
          sessionID: session.id,
          command: "sensitive",
          arguments: "",
          agent: "build",
          model: "openai/gpt-4",
        })
        const users = (await Session.messages({ sessionID: session.id })).filter((item) => item.info.role === "user")
        const user = users.at(-1)
        if (!user || user.info.role !== "user" || Message.isExternal(user.info))
          throw new Error("expected stored command message")
        const templatePart = user.parts.find((part) => part.type === "text" && part.text === template)
        if (!templatePart) throw new Error("expected stored template part")
        expect(user.info.commandSource?.templatePartIDs).toEqual([templatePart.id])
        expect(Message.userSourceTexts(user)).toEqual([template])
        expect(Message.userTaskText(user)).toBe(template)
        expect(ToolPathGuard.latestUserTexts(users)).toEqual([template])

        const seen: string[] = []
        Plugin.trigger = (async (name, input, output) => {
          if (name !== "experimental.tool.path.guard") return output
          const value = input as { text: string; paths: string[] }
          seen.push(value.text)
          return { denied: value.text === template ? value.paths : [] }
        }) as typeof Plugin.trigger
        await expect(
          ToolPathGuard.assertPathAllowed({ sessionID: session.id, messages: users } as never, "/secret", "read"),
        ).rejects.toThrow()
        expect(seen).toEqual([template])
      },
    })
  }, 15000)

  test("public prompt ignores a forged commandSource and keeps the text visible to the model", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const forged = await SessionRunner.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          noReply: true,
          commandSource: { templatePartIDs: [] },
          parts: [{ type: "text", text: "公共 prompt 正文" }],
        } as never)
        if (forged.info.role !== "user") throw new Error("expected user message")
        expect(forged.info.commandSource).toBeUndefined()
        expect(await Message.toModelMessages([forged], testModel)).toEqual([
          { role: "user", content: [{ type: "text", text: "公共 prompt 正文" }] },
        ])
      },
    })
  }, 15000)

  test("subtask command uses the expanded template as the subtask prompt", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        command: { delegated: { template: "子任务：$ARGUMENTS", description: "delegate", subtask: true } },
      } as never,
    })
    Provider.getModel = (async () => testModel) as typeof Provider.getModel
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await captureCommandParts({
          sessionID: session.id,
          command: "delegated",
          arguments: "检查 A\n检查 B",
          agent: "build",
          model: "openai/gpt-4",
        })
        expect(user.parts.map((part) => part.type)).toEqual(["subtask"])
        const subtask = user.parts[0]
        if (subtask?.type !== "subtask") throw new Error("expected subtask part")
        expect(subtask.prompt).toBe("子任务：检查 A\n检查 B")
      },
    })
  }, 15000)

  test("refused subtask still has the full task template when read back from storage", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        command: { delegated: { template: "子任务：$ARGUMENTS", description: "delegate", subtask: true } },
      } as never,
    })
    Provider.getModel = (async () => testModel) as typeof Provider.getModel
    Plugin.trigger = (async (name, _input, output) =>
      name === "experimental.chat.guard" ? { refuse: true, message: "测试停止" } : output) as typeof Plugin.trigger
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionRunner.command({
          sessionID: session.id,
          command: "delegated",
          arguments: "检查 A\n检查 B",
          agent: "build",
          model: "openai/gpt-4",
        })
        expect(result.info.role).toBe("assistant")
        const user = (await Session.messages({ sessionID: session.id })).find((item) => item.info.role === "user")
        if (!user || user.info.role !== "user" || Message.isExternal(user.info))
          throw new Error("expected stored user message")
        const subtask = user.parts.find((part) => part.type === "subtask")
        expect(subtask).toMatchObject({ prompt: "子任务：检查 A\n检查 B" })
        expect(user.info.commandSource).toEqual({ templatePartIDs: [subtask!.id] })
        expect(Message.userSourceTexts(user)).toEqual(["子任务：检查 A\n检查 B"])
      },
    })
  }, 15000)

  test("command without a placeholder appends the arguments once to the end of the template", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { command: { plain: { template: "模板-无占位", description: "plain" } } } as never,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { template } = await SessionRunner.resolveCommandInjection({ command: "plain", arguments: "做X" })
        expect(template).toBe("模板-无占位\n\n做X")
      },
    })
  })

  test("skill command loads the full skill into system and tells the model to follow it", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writeSkill(dir, "skill-a", "AAA-body")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { system } = await SessionRunner.resolveCommandInjection({ command: "skill-a", arguments: "" })
        expect(system).toContain("AAA-body")
        expect(system).toContain("Follow this skill")
      },
    })
  })

  test("bare skill command goes through prompt assembly, not the sync handler", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writeSkill(dir, "skill-a", "AAA-body")
      },
    })
    Provider.getModel = (async () => testModel) as typeof Provider.getModel

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await captureCommandParts({
          sessionID: session.id,
          command: "skill-a",
          arguments: "",
          agent: "build",
          model: "openai/gpt-4",
        })
        if (user.info.role !== "user" || Message.isExternal(user.info)) throw new Error("expected user message")
        expect(user.info.system).toContain("Follow this skill")
        expect(user.info.system).not.toContain("The user just ran the /")
        expect(user.parts.some((part) => part.type === "subtask")).toBe(false)
      },
    })
  }, 15000)

  test("skill command with task text includes the task in the prompt body", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writeSkill(dir, "skill-a", "AAA-body")
      },
    })
    Provider.getModel = (async () => testModel) as typeof Provider.getModel

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await captureCommandParts({
          sessionID: session.id,
          command: "skill-a",
          arguments: "帮我写测试",
          agent: "build",
          model: "openai/gpt-4",
        })
        if (user.info.role !== "user" || Message.isExternal(user.info)) throw new Error("expected user message")
        const text = user.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { text: string }).text)
          .join("\n")
        expect(text).toContain("帮我写测试")
        expect(user.info.system).not.toContain("The user just ran the /")
      },
    })
  }, 15000)
})
