import { describe, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import type { Tool } from "@merakcode/engine/tool/tool"
import { Instance } from "@merakcode/engine/project/instance"
import { SkillTool } from "@merakcode/engine/tool/skill"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  kind: "ask",
  abort: AbortSignal.any([]),
  messages: [],
  ruleset: [],
  metadata: () => {},
}

describe("tool.skill", () => {
  test("description lists a compact skill sample without locations", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".config", "merakcode"), { recursive: true })
        const skillDir = path.join(dir, ".merakcode", "skill", "tool-skill")
        await Filesystem.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill
`,
        )
      },
    })

    const home = process.env.MERAKCODE_TEST_HOME
    process.env.MERAKCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const skillPath = path.join(tmp.path, ".merakcode", "skill", "tool-skill", "SKILL.md")
          expect(tool.description).toContain(`<available_skill_sample shown="`)
          expect(tool.description).toContain(`<name>tool-skill</name>`)
          expect(tool.description).toContain(`<description>Skill for tool tests.</description>`)
          expect(tool.description).not.toContain(pathToFileURL(skillPath).href)
          expect(tool.description).not.toContain("<location>")
        },
      })
    } finally {
      process.env.MERAKCODE_TEST_HOME = home
    }
  })

  test("execute searches skills before loading one by name", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".config", "merakcode"), { recursive: true })
        const imageSkillDir = path.join(dir, ".merakcode", "skill", "image-skill")
        await Filesystem.write(
          path.join(imageSkillDir, "SKILL.md"),
          `---
name: image-skill
description: Generate and edit images.
---

# Image Skill
`,
        )

        const databaseSkillDir = path.join(dir, ".merakcode", "skill", "database-skill")
        await Filesystem.write(
          path.join(databaseSkillDir, "SKILL.md"),
          `---
name: database-skill
description: Design database schemas.
---

# Database Skill
`,
        )
      },
    })

    const home = process.env.MERAKCODE_TEST_HOME
    process.env.MERAKCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async () => {},
          }

          const result = await tool.execute({ query: "image" }, ctx)

          expect(result.output).toContain(`<skill_search query="image" shown="1" matched="1" total="`)
          expect(result.output).toContain(`<name>image-skill</name>`)
          expect(result.output).not.toContain(`<name>database-skill</name>`)
          expect(result.output).toContain("Call this tool again with the exact `name`")
        },
      })
    } finally {
      process.env.MERAKCODE_TEST_HOME = home
    }
  })

  test("execute returns skill content block with files", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".config", "merakcode"), { recursive: true })
        const skillDir = path.join(dir, ".merakcode", "skill", "tool-skill")
        await Filesystem.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
        )
        await Filesystem.write(path.join(skillDir, "scripts", "demo.txt"), "demo")
        await Filesystem.write(path.join(skillDir, ".merakcode", "install-receipt.json"), '{"source":"some-market"}')
      },
    })

    const home = process.env.MERAKCODE_TEST_HOME
    process.env.MERAKCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const requests: Array<Parameters<Tool.Context["ask"]>[0]> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async (req) => {
              requests.push(req)
            },
          }

          const result = await tool.execute({ name: "tool-skill" }, ctx)
          const dir = path.join(tmp.path, ".merakcode", "skill", "tool-skill")
          const file = path.resolve(dir, "scripts", "demo.txt")
          const receipt = path.resolve(dir, ".merakcode", "install-receipt.json")

          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("skill")
          expect(requests[0].patterns).toContain("tool-skill")

          expect(result.metadata.dir).toBe(dir)
          expect(result.output).toContain(`<skill_content name="tool-skill">`)
          expect(result.output).toContain(`Base directory for this skill: ${pathToFileURL(dir).href}`)
          expect(result.output).toContain(`<file>${file}</file>`)
          expect(result.output.includes(`<file>${receipt}</file>`)).toBe(true)
        },
      })
    } finally {
      process.env.MERAKCODE_TEST_HOME = home
    }
  })
})
