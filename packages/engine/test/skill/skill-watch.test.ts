import { describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { Skill } from "@merakcode/engine/skill/index"
import { SkillWatch } from "@merakcode/engine/skill/skill-watch"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

function userSkills(skills: Awaited<ReturnType<typeof Skill.all>>) {
  return skills.filter((s) => s.scope !== "builtin")
}

describe("SkillWatch", () => {
  test("flushGlobal returns true when changes are pending (invalidates and broadcasts)", async () => {
    SkillWatch.__testingQueueGlobal()
    expect(await SkillWatch.__testingFlushGlobal()).toBe(true)
  })

  test("flushGlobal returns false on an empty queue", async () => {
    expect(await SkillWatch.__testingFlushGlobal()).toBe(false)
  })

  test("flushProject invalidates the cache so Skill.all reflects deletions on disk", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".claude", "skills", "watch-skill", "SKILL.md"),
          `---
name: watch-skill
description: For watch test.
---

# Watch Skill
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(userSkills(await Skill.all()).some((s) => s.name === "watch-skill")).toBe(true)

        // The cache still returns the deleted skill until it is invalidated.
        await fs.rm(path.join(tmp.path, ".claude", "skills", "watch-skill"), { recursive: true, force: true })
        expect(userSkills(await Skill.all()).some((s) => s.name === "watch-skill")).toBe(true)

        SkillWatch.__testingQueueProject(Instance.directory)
        expect(await SkillWatch.__testingFlushProject(Instance.directory)).toBe(true)
        expect(userSkills(await Skill.all()).some((s) => s.name === "watch-skill")).toBe(false)
      },
    })
  })
})
