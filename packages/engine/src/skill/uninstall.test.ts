import { describe, expect, test } from "vitest"
import path from "path"
import { existsSync } from "fs"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { resolveSkillInstallRoot } from "./uninstall"

describe("resolveSkillInstallRoot", () => {
  const root = path.resolve("/proj/.merakcode/skills")

  test("uses the direct parent of SKILL.md as the install root in a flat layout", () => {
    const location = path.join(root, "my-skill", "SKILL.md")
    expect(resolveSkillInstallRoot(location, [root])).toBe(path.join(root, "my-skill"))
  })

  test("resolves a nested layout (zip outer/inner) to the first level under the allowed root", () => {
    const location = path.join(root, "my-skill", "nested", "SKILL.md")
    expect(resolveSkillInstallRoot(location, [root])).toBe(path.join(root, "my-skill"))
  })

  test("returns undefined for a path outside the allowed roots", () => {
    expect(resolveSkillInstallRoot("/tmp/evil/SKILL.md", [root])).toBeUndefined()
  })

  test("does not treat a sibling with the same prefix (skills-extra) as inside skills", () => {
    const sibling = path.resolve("/proj/.merakcode/skills-extra/foo/SKILL.md")
    expect(resolveSkillInstallRoot(sibling, [root])).toBeUndefined()
  })

  test("refuses to delete the skills root itself", () => {
    expect(resolveSkillInstallRoot(path.join(root, "SKILL.md"), [root])).toBeUndefined()
  })

  test("picks the matching root among several allowed roots", () => {
    const global = path.resolve("/home/.merakcode/skills")
    const location = path.join(global, "shared", "inner", "SKILL.md")
    expect(resolveSkillInstallRoot(location, [root, global])).toBe(path.join(global, "shared"))
  })

  test("deleting removes the whole nested install root and keeps the skills root", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "mc-skill-uninstall-"))
    const skillsRoot = path.join(base, ".merakcode", "skills")
    const location = path.join(skillsRoot, "my-skill", "nested", "SKILL.md")
    await mkdir(path.dirname(location), { recursive: true })
    await writeFile(location, "---\nname: my-skill\n---\n")

    const installRoot = resolveSkillInstallRoot(location, [skillsRoot])
    expect(installRoot).toBe(path.join(skillsRoot, "my-skill"))

    await rm(installRoot!, { recursive: true, force: true })
    expect(existsSync(path.join(skillsRoot, "my-skill"))).toBe(false)
    expect(existsSync(skillsRoot)).toBe(true)

    await rm(base, { recursive: true, force: true })
  })
})
