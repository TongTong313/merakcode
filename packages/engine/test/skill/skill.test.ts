import { test, expect } from "vitest"
import { Skill } from "@merakcode/engine/skill/index"
import { Command } from "@merakcode/engine/command/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Global } from "@merakcode/engine/global/index"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "@merakcode/util/filesystem"

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Filesystem.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.claude/skills for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

function userSkills(skills: Awaited<ReturnType<typeof Skill.all>>) {
  return skills.filter((skill) => skill.scope !== "builtin")
}

function slash(input: string) {
  return input.replace(/\\/g, "/")
}

test("discovers skills from .merakcode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".merakcode", "skill", "test-skill")
      await Filesystem.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = userSkills(await Skill.all())
      expect(skills.length).toBe(1)
      const testSkill = skills.find((s) => s.name === "test-skill")
      expect(testSkill).toBeDefined()
      expect(testSkill!.description).toBe("A test skill for verification.")
      expect(slash(testSkill!.location)).toContain("skill/test-skill/SKILL.md")
    },
  })
})

test("returns skill directories from Skill.dirs", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".merakcode", "skill", "dir-skill")
      await Filesystem.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: dir-skill
description: Skill for dirs test.
---

# Dir Skill
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
        const dirs = (await Skill.dirs()).filter((dir) => dir.startsWith(tmp.path))
        const skillDir = path.join(tmp.path, ".merakcode", "skill", "dir-skill")
        expect(dirs).toContain(skillDir)
        expect(dirs.length).toBe(1)
      },
    })
  } finally {
    process.env.MERAKCODE_TEST_HOME = home
  }
})

test("discovers multiple skills from .merakcode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir1 = path.join(dir, ".merakcode", "skill", "skill-one")
      const skillDir2 = path.join(dir, ".merakcode", "skill", "skill-two")
      await Filesystem.write(
        path.join(skillDir1, "SKILL.md"),
        `---
name: skill-one
description: First test skill.
---

# Skill One
`,
      )
      await Filesystem.write(
        path.join(skillDir2, "SKILL.md"),
        `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = userSkills(await Skill.all())
      expect(skills.length).toBe(2)
      expect(skills.find((s) => s.name === "skill-one")).toBeDefined()
      expect(skills.find((s) => s.name === "skill-two")).toBeDefined()
    },
  })
})

test("loads skills with missing frontmatter using defaults", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".merakcode", "skill", "no-frontmatter")
      await Filesystem.write(
        path.join(skillDir, "SKILL.md"),
        `# No Frontmatter

Just some content without YAML frontmatter.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = userSkills(await Skill.all())
      expect(skills.length).toBe(1)
      expect(skills[0].name).toBe("no-frontmatter")
      expect(skills[0].description).toBe("")
    },
  })
})

test("discovers skills from .claude/skills/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".claude", "skills", "claude-skill")
      await Filesystem.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = userSkills(await Skill.all())
      expect(skills.length).toBe(1)
      const claudeSkill = skills.find((s) => s.name === "claude-skill")
      expect(claudeSkill).toBeDefined()
      expect(slash(claudeSkill!.location)).toContain(".claude/skills/claude-skill/SKILL.md")
    },
  })
})

test("discovers global skills from ~/.claude/skills/ directory", async () => {
  await using tmp = await tmpdir({ git: true })

  const originalHome = process.env.MERAKCODE_TEST_HOME
  process.env.MERAKCODE_TEST_HOME = tmp.path

  try {
    await createGlobalSkill(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = userSkills(await Skill.all())
        expect(skills.length).toBe(1)
        expect(skills[0].name).toBe("global-test-skill")
        expect(skills[0].description).toBe("A global skill from ~/.claude/skills for testing.")
        expect(slash(skills[0].location)).toContain(".claude/skills/global-test-skill/SKILL.md")
      },
    })
  } finally {
    process.env.MERAKCODE_TEST_HOME = originalHome
  }
})

test("returns empty array when no skills exist", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = userSkills(await Skill.all())
      expect(skills).toEqual([])
    },
  })
})

test("discovers skills from .agents/skills/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".agents", "skills", "agent-skill")
      await Filesystem.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = userSkills(await Skill.all())
      expect(skills.length).toBe(1)
      const agentSkill = skills.find((s) => s.name === "agent-skill")
      expect(agentSkill).toBeDefined()
      expect(slash(agentSkill!.location)).toContain(".agents/skills/agent-skill/SKILL.md")
    },
  })
})

test("discovers global skills from ~/.agents/skills/ directory", async () => {
  await using tmp = await tmpdir({ git: true })

  const originalHome = process.env.MERAKCODE_TEST_HOME
  process.env.MERAKCODE_TEST_HOME = tmp.path

  try {
    const skillDir = path.join(tmp.path, ".agents", "skills", "global-agent-skill")
    await fs.mkdir(skillDir, { recursive: true })
    await Filesystem.write(
      path.join(skillDir, "SKILL.md"),
      `---
name: global-agent-skill
description: A global skill from ~/.agents/skills for testing.
---

# Global Agent Skill

This skill is loaded from the global home directory.
`,
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = userSkills(await Skill.all())
        expect(skills.length).toBe(1)
        expect(skills[0].name).toBe("global-agent-skill")
        expect(skills[0].description).toBe("A global skill from ~/.agents/skills for testing.")
        expect(slash(skills[0].location)).toContain(".agents/skills/global-agent-skill/SKILL.md")
      },
    })
  } finally {
    process.env.MERAKCODE_TEST_HOME = originalHome
  }
})

test("discovers skills from both .claude/skills/ and .agents/skills/", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const claudeDir = path.join(dir, ".claude", "skills", "claude-skill")
      const agentDir = path.join(dir, ".agents", "skills", "agent-skill")
      await Filesystem.write(
        path.join(claudeDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
      await Filesystem.write(
        path.join(agentDir, "SKILL.md"),
        `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = userSkills(await Skill.all())
      expect(skills.length).toBe(2)
      expect(skills.find((s) => s.name === "claude-skill")).toBeDefined()
      expect(skills.find((s) => s.name === "agent-skill")).toBeDefined()
    },
  })
})

test("properly resolves directories that skills live in", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const merakCodeSkillDir = path.join(dir, ".merakcode", "skill", "agent-skill")
      const merakCodeSkillsDir = path.join(dir, ".merakcode", "skills", "agent-skill")
      const claudeDir = path.join(dir, ".claude", "skills", "claude-skill")
      const agentDir = path.join(dir, ".agents", "skills", "agent-skill")
      await Filesystem.write(
        path.join(claudeDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
      await Filesystem.write(
        path.join(agentDir, "SKILL.md"),
        `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
      )
      await Filesystem.write(
        path.join(merakCodeSkillDir, "SKILL.md"),
        `---
name: merakcode-skill
description: A skill in the .merakcode/skill directory.
---

# MerakCode Skill
`,
      )
      await Filesystem.write(
        path.join(merakCodeSkillsDir, "SKILL.md"),
        `---
name: merakcode-skill
description: A skill in the .merakcode/skills directory.
---

# MerakCode Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dirs = (await Skill.dirs()).filter((dir) => dir.startsWith(tmp.path))
      expect(dirs.length).toBe(3)
    },
  })
})

// Scope and slash commands: Claude Code skills stay readable and invokable at both project and global level.

test("home as git worktree: global config dir skill carries scope global", async () => {
  // Common on Mac/Linux: with ~/ as a git root, ~/.config/merakcode sits inside the worktree but is not project.
  await using home = await tmpdir({ git: true })
  const prevHome = process.env.MERAKCODE_TEST_HOME
  process.env.MERAKCODE_TEST_HOME = home.path

  const skillDir = path.join(home.path, ".config", "merakcode", "skills", "home-global-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Filesystem.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: home-global-skill
description: Global skill under home .config/merakcode/skills.
---

# Home Global Skill
`,
  )

  try {
    await Instance.provide({
      directory: home.path,
      fn: async () => {
        const skill = userSkills(await Skill.all()).find((s) => s.name === "home-global-skill")
        expect(skill).toBeDefined()
        expect(skill!.scope).toBe("global")
      },
    })
  } finally {
    process.env.MERAKCODE_TEST_HOME = prevHome
  }
})

test("non-git project: global config dir skill carries scope global", async () => {
  // Without git the worktree is "/", so on Unix every absolute path would look like project (see configDirScope).
  await using project = await tmpdir()
  const skillDir = path.join(Global.Path.config, "skills", "global-config-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Filesystem.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-config-skill
description: Installed to ~/.config/merakcode/skills via global target.
---

# Global Config Skill
`,
  )

  await Instance.provide({
    directory: project.path,
    fn: async () => {
      expect(Instance.worktree).toBe("/")
      const skill = userSkills(await Skill.all()).find((s) => s.name === "global-config-skill")
      expect(skill).toBeDefined()
      expect(skill!.scope).toBe("global")
    },
  })
})

test("project-level .claude/skills skill carries scope project", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".claude", "skills", "scoped-claude")
      await Filesystem.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: scoped-claude
description: Project-level claude skill.
---

# Scoped Claude
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skill = userSkills(await Skill.all()).find((s) => s.name === "scoped-claude")
      expect(skill).toBeDefined()
      expect(skill!.scope).toBe("project")
    },
  })
})

test("global-level ~/.claude/skills skill carries scope global", async () => {
  // Home and the project worktree must differ; otherwise one .claude directory is scanned as both global and project,
  // and since project wins when merging, the global skill would be labeled project.
  await using home = await tmpdir()
  await using project = await tmpdir({ git: true })

  const originalHome = process.env.MERAKCODE_TEST_HOME
  process.env.MERAKCODE_TEST_HOME = home.path

  try {
    await createGlobalSkill(home.path)
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const skill = userSkills(await Skill.all()).find((s) => s.name === "global-test-skill")
        expect(skill).toBeDefined()
        expect(skill!.scope).toBe("global")
      },
    })
  } finally {
    process.env.MERAKCODE_TEST_HOME = originalHome
  }
})

test("project-level .merakcode/skills (plural) skill is discovered with scope project", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".merakcode", "skills", "mc-plural")
      await Filesystem.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: mc-plural
description: Skill under .merakcode/skills plural dir.
---

# MC Plural
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skill = userSkills(await Skill.all()).find((s) => s.name === "mc-plural")
      expect(skill).toBeDefined()
      expect(skill!.scope).toBe("project")
    },
  })
})

test("a discovered skill is exposed as an invokable slash command (source skill)", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".claude", "skills", "cmd-skill")
      await Filesystem.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: cmd-skill
description: A skill that should appear as a slash command.
---

# Cmd Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const command = (await Command.list()).find((c) => c.name === "cmd-skill")
      expect(command).toBeDefined()
      expect(command!.source).toBe("skill")
    },
  })
})

test("same skill name in project and global returns two install rows", async () => {
  await using home = await tmpdir()
  await using project = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".merakcode", "skills", "dual-scope-skill")
      await fs.mkdir(skillDir, { recursive: true })
      await Filesystem.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: dual-scope-skill
description: Project copy.
---

# Dual Scope
`,
      )
    },
  })

  const originalHome = process.env.MERAKCODE_TEST_HOME
  process.env.MERAKCODE_TEST_HOME = home.path

  try {
    const globalDir = path.join(home.path, ".config", "merakcode", "skills", "dual-scope-skill")
    await fs.mkdir(globalDir, { recursive: true })
    await Filesystem.write(
      path.join(globalDir, "SKILL.md"),
      `---
name: dual-scope-skill
description: Global copy.
---

# Dual Scope Global
`,
    )

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const skills = userSkills(await Skill.all()).filter((s) => s.name === "dual-scope-skill")
        expect(skills).toHaveLength(2)
        expect(skills.map((s) => s.scope).sort()).toEqual(["global", "project"])
        expect(new Set(skills.map((s) => s.location)).size).toBe(2)
      },
    })
  } finally {
    process.env.MERAKCODE_TEST_HOME = originalHome
  }
})
