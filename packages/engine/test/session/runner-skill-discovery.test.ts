import { describe, expect, test } from "vitest"
import type { Agent } from "@merakcode/engine/agent/agent"
import { PermissionNext } from "@merakcode/engine/permission/next"
import { Instance } from "@merakcode/engine/project/instance"
import { Message } from "@merakcode/engine/session/message"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { SkillSearch } from "@merakcode/engine/skill/search"
import type { Skill } from "@merakcode/engine/skill/skill"
import { tmpdir } from "../fixture/fixture"

const sessionID = "session"

function agent(input: Partial<Agent.Info> = {}): Agent.Info {
  return {
    id: "build",
    name: "build",
    mode: "primary",
    permission: [],
    options: {},
    profile: {
      availableTools: ["skill", "read", "bash"],
    },
    ...input,
  } as Agent.Info
}

function skill(input: Partial<Skill.Info> & Pick<Skill.Info, "name" | "description">): Skill.Info {
  return {
    location: `/skills/${input.name}/SKILL.md`,
    content: "",
    ...input,
  }
}

function user(id = "msg_user"): Message.UserInfo {
  return {
    id,
    sessionID,
    role: "user",
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    tools: { skill: true },
    time: { created: 0 },
  } as Message.UserInfo
}

function assistantMessage(id: string, tool: string): Message.FullMsg {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID: "msg_user",
      mode: "build",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test",
      providerID: "test",
      finish: "tool-calls",
      time: { created: 0 },
    } as Message.AssistantInfo,
    parts: [
      {
        id: `${id}_part`,
        messageID: id,
        sessionID,
        type: "tool",
        tool,
        callID: `${id}_call`,
        state: {
          status: "completed",
          input: {},
          output: "",
          title: "",
          metadata: {},
          time: { start: 0, end: 0 },
        },
      },
    ],
  }
}

describe("SessionRunner skill discovery helpers", () => {
  test("uses the first user message as the first-turn trigger", () => {
    const info = user()
    const trigger = SessionRunner.skillDiscoveryTrigger({
      step: 1,
      messages: [{ info, parts: [] }],
      user: info,
      consumed: new Set(),
    })

    expect(trigger).toEqual({ id: info.id, kind: "user_message" })
  })

  test("does not trigger after non-write tools", () => {
    const info = user()
    const trigger = SessionRunner.skillDiscoveryTrigger({
      step: 2,
      messages: [{ info, parts: [] }, assistantMessage("msg_assistant", "read")],
      user: info,
      consumed: new Set(),
    })

    expect(trigger).toBeUndefined()
  })

  test("uses the latest completed write tool as a one-time trigger", () => {
    const info = user()
    const messages = [{ info, parts: [] }, assistantMessage("msg_assistant", "edit")]
    const trigger = SessionRunner.skillDiscoveryTrigger({
      step: 2,
      messages,
      user: info,
      consumed: new Set(),
    })
    const consumed = new Set(trigger ? [trigger.id] : [])

    expect(trigger).toEqual({ id: "msg_assistant", kind: "write_pivot" })
    expect(
      SessionRunner.skillDiscoveryTrigger({
        step: 2,
        messages,
        user: info,
        consumed,
      }),
    ).toBeUndefined()
  })

  test("filters prefetched attachments by trigger, discovered names, loaded skills, and access rules", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = user()
        const image = skill({ name: "imagegen", description: "Generate and edit images." })
        const blocked = skill({ name: "blocked-skill", description: "Blocked by rules." })
        const loaded = skill({ name: "loaded-skill", description: "Already loaded." })
        const attachment: SkillSearch.Attachment = {
          text: SkillSearch.renderAttachment([image, blocked, loaded]),
          skills: [image, blocked, loaded],
          query: "generate images",
          messageID: info.id,
          triggerID: "msg_write",
        }
        const messages = [
          { info, parts: [] },
          assistantMessage("msg_write", "write"),
          {
            ...assistantMessage("msg_skill", "skill"),
            parts: [
              {
                ...assistantMessage("msg_skill", "skill").parts[0],
                state: {
                  status: "completed" as const,
                  input: { name: loaded.name },
                  output: "",
                  title: "",
                  metadata: { name: loaded.name },
                  time: { start: 0, end: 0 },
                },
              },
            ],
          },
        ]
        const filtered = await SessionRunner.filterSkillAttachment({
          attachment,
          trigger: { id: "msg_write", kind: "write_pivot" },
          messages,
          agent: agent({
            permission: PermissionNext.fromConfig({ skill: { "blocked-skill": "deny" } }),
          }),
          ruleset: PermissionNext.fromConfig({ skill: { "blocked-skill": "deny" } }),
          user: info,
          discovered: new Set(["imagegen"]),
        })

        expect(filtered).toBeUndefined()
      },
    })
  })

  test("rejects prefetched attachments for a different trigger", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = user()
        const image = skill({ name: "imagegen", description: "Generate and edit images." })
        const filtered = await SessionRunner.filterSkillAttachment({
          attachment: {
            text: SkillSearch.renderAttachment([image]),
            skills: [image],
            query: "generate images",
            messageID: info.id,
            triggerID: "msg_old",
          },
          trigger: { id: "msg_current", kind: "write_pivot" },
          messages: [{ info, parts: [] }],
          agent: agent(),
          ruleset: [],
          user: info,
          discovered: new Set(),
        })

        expect(filtered).toBeUndefined()
      },
    })
  })
})
