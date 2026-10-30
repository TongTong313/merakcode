import { afterEach, describe, test, expect } from "vitest"
import path from "path"
import { SkillInstall } from "@merakcode/engine/agent/skill/install"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

describe("SkillInstall.parse", () => {
  test("parses owner/repo", () => {
    const r = SkillInstall.parse("huggingface/skills")
    expect(r).toEqual({
      type: "github",
      url: "https://github.com/huggingface/skills.git",
      owner: "huggingface",
      repo: "skills",
    })
  })

  test("parses owner/repo with extra chars", () => {
    const r = SkillInstall.parse("  huggingface/skills  ")
    expect(r).toEqual({
      type: "github",
      url: "https://github.com/huggingface/skills.git",
      owner: "huggingface",
      repo: "skills",
    })
  })

  test("parses full github url", () => {
    const r = SkillInstall.parse("https://github.com/huggingface/skills")
    expect(r).toEqual({
      type: "github",
      url: "https://github.com/huggingface/skills.git",
      owner: "huggingface",
      repo: "skills",
    })
  })

  test("parses github url with .git", () => {
    const r = SkillInstall.parse("https://github.com/huggingface/skills.git")
    expect(r).toEqual({
      type: "github",
      url: "https://github.com/huggingface/skills.git",
      owner: "huggingface",
      repo: "skills",
    })
  })

  test("parses gitee url with .git", () => {
    const r = SkillInstall.parse("https://gitee.com/moark/moark-skills.git")
    expect(r).toEqual({
      type: "github",
      url: "https://gitee.com/moark/moark-skills.git",
      owner: "moark",
      repo: "moark-skills",
    })
  })

  // A gitee repo page URL must become a cloneable source, not a Discovery index.json lookup.
  test("parses a gitee root URL without .git as a cloneable source", () => {
    const r = SkillInstall.parse("https://gitee.com/hongmaple/agent-academy")
    expect(r).toEqual({
      type: "github",
      url: "https://gitee.com/hongmaple/agent-academy.git",
      owner: "hongmaple",
      repo: "agent-academy",
    })
  })

  test("parses a gitee root URL with a trailing slash", () => {
    const r = SkillInstall.parse("https://gitee.com/hongmaple/agent-academy/")
    expect(r).toEqual({
      type: "github",
      url: "https://gitee.com/hongmaple/agent-academy.git",
      owner: "hongmaple",
      repo: "agent-academy",
    })
  })

  test("parses gitlab / gitcode root URLs as cloneable sources", () => {
    expect(SkillInstall.parse("https://gitlab.com/acme/skills")).toEqual({
      type: "github",
      url: "https://gitlab.com/acme/skills.git",
      owner: "acme",
      repo: "skills",
    })
    expect(SkillInstall.parse("https://gitcode.com/maple/academy")).toEqual({
      type: "github",
      url: "https://gitcode.com/maple/academy.git",
      owner: "maple",
      repo: "academy",
    })
  })

  test("parses a github tree link to a subdirectory with branch and subpath", () => {
    const r = SkillInstall.parse("https://github.com/mattpocock/skills/tree/main/skills/engineering/")
    expect(r).toEqual({
      type: "github",
      url: "https://github.com/mattpocock/skills.git",
      owner: "mattpocock",
      repo: "skills",
      branch: "main",
      subpath: "skills/engineering",
    })
  })

  test("parses a github tree link to a single skill directory", () => {
    const r = SkillInstall.parse("https://github.com/mattpocock/skills/tree/main/skills/engineering/implement")
    expect(r).toEqual({
      type: "github",
      url: "https://github.com/mattpocock/skills.git",
      owner: "mattpocock",
      repo: "skills",
      branch: "main",
      subpath: "skills/engineering/implement",
    })
  })

  test("parses a github blob link, using the file path as subpath", () => {
    const r = SkillInstall.parse("https://github.com/acme/skills/blob/dev/pkg/a")
    expect(r).toEqual({
      type: "github",
      url: "https://github.com/acme/skills.git",
      owner: "acme",
      repo: "skills",
      branch: "dev",
      subpath: "pkg/a",
    })
  })

  test("parses a github tree link to the branch root without subpath", () => {
    const r = SkillInstall.parse("https://github.com/acme/skills/tree/main")
    expect(r).toEqual({
      type: "github",
      url: "https://github.com/acme/skills.git",
      owner: "acme",
      repo: "skills",
      branch: "main",
    })
  })

  test("parses discovery url", () => {
    const r = SkillInstall.parse("https://developers.cloudflare.com/.well-known/skills/")
    expect(r).toEqual({ type: "url", url: "https://developers.cloudflare.com/.well-known/skills/" })
  })

  test("returns invalid for empty", () => {
    const r = SkillInstall.parse("")
    expect(r).toEqual({ type: "invalid" })
  })

  test("returns invalid for bad format", () => {
    const r = SkillInstall.parse("not-valid")
    expect(r).toEqual({ type: "invalid" })
  })
})

describe("SkillInstall.list", () => {
  const originalSpawn = Process.spawn
  afterEach(() => {
    Process.spawn = originalSpawn
    delete process.env.MERAKCODE_TEST_SKILL_CACHE
  })

  test("parse then list: a gitee root URL without .git clones and lists nested skills/**/SKILL.md", async () => {
    await using tmp = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = tmp.path
    Process.spawn = ((cmd: string[]) => {
      const setup = (async () => {
        if (cmd.includes("clone")) {
          const { mkdir } = await import("fs/promises")
          const dest = cmd.at(-1)!
          const skillDir = path.join(dest, "skills", "development", "git-workflow")
          await mkdir(skillDir, { recursive: true })
          await Filesystem.write(path.join(skillDir, "SKILL.md"), `---\nname: git-workflow\ndescription: Git\n---\n`)
        }
        return 0
      })()
      return { exited: setup, stderr: new ReadableStream() } as Process.Child
    }) as typeof Process.spawn

    const parsed = SkillInstall.parse("https://gitee.com/acme/academy")
    expect(parsed.type).toBe("github")
    if (parsed.type !== "github") return

    const listed = await SkillInstall.list(parsed)
    expect(listed.skills.map((s) => s.name)).toEqual(["git-workflow"])
    expect(listed.skills[0]?.path).toBe("skills/development/git-workflow")
    expect(listed.skills[0]?.description).toBe("Git")
  })

  test("a github source with auth injects http.extraHeader into the clone (Source.auth reaches clone)", async () => {
    await using tmp = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = tmp.path
    let env: Record<string, any> | undefined
    Process.spawn = ((cmd: string[], opts: Record<string, any>) => {
      env = opts?.env
      const setup = (async () => {
        // Only write the placeholder skill for clone, so stray spawns never write files to a relative path.
        if (cmd.includes("clone")) {
          const { mkdir } = await import("fs/promises")
          const d = path.join(cmd.at(-1)!, "foo")
          await mkdir(d, { recursive: true })
          await Filesystem.write(path.join(d, "SKILL.md"), `---\nname: foo\n---\n`)
        }
        return 0
      })()
      return { exited: setup, stderr: new ReadableStream() } as Process.Child
    }) as typeof Process.spawn

    await SkillInstall.list({
      type: "github",
      url: "https://gitee.com/o/r.git",
      auth: { token: "PAT", username: "me" },
    })

    expect(env?.GIT_CONFIG_KEY_0).toBe("http.extraHeader")
    expect(env?.GIT_CONFIG_VALUE_0).toContain(`Basic ${btoa("me:PAT")}`)
  })
})

describe("SkillInstall.install", () => {
  const originalSpawn = Process.spawn
  afterEach(() => {
    Process.spawn = originalSpawn
    delete process.env.MERAKCODE_TEST_SKILL_CACHE
  })

  // Installing must not delete the temporary clone, so several skills can be installed from one list result.
  test("installs two skills in a row from the same list result", async () => {
    await using cache = await tmpdir()
    await using project = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = cache.path
    Process.spawn = ((cmd: string[]) => {
      const setup = (async () => {
        if (cmd.includes("clone")) {
          const { mkdir } = await import("fs/promises")
          const dest = cmd.at(-1)!
          for (const name of ["foo", "bar"] as const) {
            const d = path.join(dest, name)
            await mkdir(d, { recursive: true })
            await Filesystem.write(path.join(d, "SKILL.md"), `---\nname: ${name}\n---\n`)
          }
        }
        return 0
      })()
      return { exited: setup, stderr: new ReadableStream() } as Process.Child
    }) as typeof Process.spawn

    const source = {
      type: "github" as const,
      url: "https://github.com/acme/skills.git",
      owner: "acme",
      repo: "skills",
    }
    const listed = await SkillInstall.list(source)
    const foo = listed.skills.find((s) => s.name === "foo")
    const bar = listed.skills.find((s) => s.name === "bar")
    expect(foo).toBeDefined()
    expect(bar).toBeDefined()
    if (!foo || !bar) return

    const first = await SkillInstall.install(source, [foo], "project", project.path)
    expect(first.installed).toEqual(["foo"])
    expect(first.failed).toEqual([])

    const second = await SkillInstall.install(source, [bar], "project", project.path)
    expect(second.installed).toEqual(["bar"])
    expect(second.failed).toEqual([])
    expect(await Filesystem.isFile(path.join(project.path, ".merakcode", "skills", "bar", "SKILL.md"))).toBe(true)
  })
})
