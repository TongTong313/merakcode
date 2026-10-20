import { describe, expect, test } from "vitest"
import type { Agent } from "@merakcode/engine/agent/agent"
import { PermissionNext } from "@merakcode/engine/permission/next"
import { Message } from "@merakcode/engine/session/message"
import { SkillSearch } from "@merakcode/engine/skill/search"
import type { Skill } from "@merakcode/engine/skill/skill"

const sessionID = "session"

function skill(input: Partial<Skill.Info> & Pick<Skill.Info, "name" | "description">): Skill.Info {
  return {
    location: `/skills/${input.name}/SKILL.md`,
    content: "",
    ...input,
  }
}

function agent(input: Partial<Agent.Info> = {}): Agent.Info {
  return {
    id: "build",
    name: "build",
    mode: "primary",
    permission: [],
    options: {},
    ...input,
  } as Agent.Info
}

function userMessage(id: string, text: string): Message.FullMsg {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    } as Message.UserInfo,
    parts: [
      {
        id: `${id}_part`,
        messageID: id,
        sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function loadedSkillMessage(name: string): Message.FullMsg {
  return {
    info: {
      id: "msg_assistant",
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
        id: "part_tool",
        messageID: "msg_assistant",
        sessionID,
        type: "tool",
        tool: "skill",
        callID: "call_skill",
        state: {
          status: "completed",
          input: { name },
          output: "",
          title: "Loaded skill",
          metadata: { name },
          time: { start: 0, end: 0 },
        },
      },
    ],
  }
}

describe("SkillSearch", () => {
  test("ranks relevant skills from the latest real user text", () => {
    const matches = SkillSearch.rank({
      skills: [
        skill({ name: "database", description: "Design database schemas and migrations." }),
        skill({ name: "imagegen", description: "Generate and edit bitmap images." }),
      ],
      query: "Please design a database migration for this schema",
    })

    expect(matches.map((item) => item.name)).toEqual(["database"])
  })

  test("search ranks token-overlap matches without requiring every query word", () => {
    const { shown } = SkillSearch.search(
      [
        skill({ name: "release-notes", description: "Create release notes and changelogs." }),
        skill({ name: "database", description: "Design database schemas and migrations." }),
      ],
      "please create a changelog for the current release after editing files",
      10,
    )

    expect(shown.map((item) => item.name)).toEqual(["release-notes"])
  })

  test("rank excludes discovered skill names", () => {
    const matches = SkillSearch.rank({
      skills: [
        skill({ name: "imagegen", description: "Generate and edit bitmap images." }),
        skill({ name: "design-review", description: "Review UI designs and implementation details." }),
      ],
      query: "generate and edit image assets",
      exclude: new Set(["imagegen"]),
    })

    expect(matches.map((item) => item.name)).toEqual([])
  })

  test("ranks Chinese query against Chinese descriptions", () => {
    const matches = SkillSearch.rank({
      skills: [
        skill({ name: "imagegen", description: "生成和编辑图片素材。" }),
        skill({ name: "database", description: "设计数据库 schema。" }),
      ],
      query: "帮我生成图片封面",
    })

    expect(matches.map((item) => item.name)).toEqual(["imagegen"])
  })

  test("filters skills the agent's permission rules deny", () => {
    const accessible = SkillSearch.filterAccessible({
      agent: agent({
        id: "build",
        permission: PermissionNext.fromConfig({ skill: { "blocked-skill": "deny" } }),
      }),
      skills: [
        skill({ name: "blocked-skill", description: "Hidden by permission." }),
        skill({ name: "visible-skill", description: "Visible." }),
      ],
    })

    expect(accessible.map((item) => item.name)).toEqual(["visible-skill"])
  })

  test("attachment skips skills that were already loaded", async () => {
    const messages = [userMessage("msg_user", "Use image generation for this asset"), loadedSkillMessage("imagegen")]

    const result = SkillSearch.rank({
      skills: [
        skill({ name: "imagegen", description: "Generate and edit images." }),
        skill({ name: "database", description: "Design database schemas." }),
      ],
      query: SkillSearch.latestUserText(messages),
      exclude: SkillSearch.loadedSkillNames(messages),
    })

    expect(result.map((item) => item.name)).toEqual([])
  })
})

describe("SkillSearch.hasMatchingSuggestion", () => {
  function suggestionPart(query: string, names: string[]): Message.TextPart {
    return {
      id: "part_suggestion",
      messageID: "msg_user",
      sessionID,
      type: "text",
      text: "",
      synthetic: true,
      ignored: true,
      metadata: { skill: { kind: SkillSearch.METADATA_KIND, signature: JSON.stringify({ query, names }) } },
    }
  }

  test("same query with the same skills in the same order counts as a duplicate suggestion", () => {
    const messages: Message.FullMsg[] = [
      {
        info: userMessage("msg_user", "help me chart this").info,
        parts: [suggestionPart("help me chart this", ["dataviz"])],
      },
    ]
    const attachment = { query: "help me chart this", skills: [skill({ name: "dataviz", description: "Charts." })] }
    expect(SkillSearch.hasMatchingSuggestion(messages, attachment)).toBe(true)
  })

  test("a different query is not a duplicate, so the suggestion may repeat", () => {
    const messages: Message.FullMsg[] = [
      {
        info: userMessage("msg_user", "help me chart this").info,
        parts: [suggestionPart("help me chart this", ["dataviz"])],
      },
    ]
    const attachment = {
      query: "add a legend to the chart",
      skills: [skill({ name: "dataviz", description: "Charts." })],
    }
    expect(SkillSearch.hasMatchingSuggestion(messages, attachment)).toBe(false)
  })

  test("a different skill set is not a duplicate", () => {
    const messages: Message.FullMsg[] = [
      {
        info: userMessage("msg_user", "help me chart this").info,
        parts: [suggestionPart("help me chart this", ["dataviz"])],
      },
    ]
    const attachment = {
      query: "help me chart this",
      skills: [skill({ name: "dataviz", description: "Charts." }), skill({ name: "database", description: "DB." })],
    }
    expect(SkillSearch.hasMatchingSuggestion(messages, attachment)).toBe(false)
  })

  test("is not a duplicate when history holds no prior suggestion", () => {
    const messages: Message.FullMsg[] = [userMessage("msg_user", "help me chart this")]
    const attachment = { query: "help me chart this", skills: [skill({ name: "dataviz", description: "Charts." })] }
    expect(SkillSearch.hasMatchingSuggestion(messages, attachment)).toBe(false)
  })
})
