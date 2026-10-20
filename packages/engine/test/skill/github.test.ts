import path from "path"
import { afterEach, describe, expect, test } from "vitest"
import { SkillGithub } from "@merakcode/engine/skill/github"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

const originalSpawn = Process.spawn

afterEach(() => {
  Process.spawn = originalSpawn
  delete process.env.MERAKCODE_TEST_SKILL_CACHE
})

/**
 * Replaces `git clone` with a fake that writes `files` into the destination given as the last argument.
 *
 * Only `git clone` may be intercepted; everything else must pass through. Process.spawn is shared in-process, so
 * other in-flight spawns (such as ripgrep's `rg --files … --hidden`) also arrive here while the mock is active.
 * Treating them as clones would turn the trailing `--hidden` into a relative path, create a `--hidden/` directory
 * under apps/cli full of skill fixtures, pollute the worktree and starve the real call of its result.
 */
function mockClone(files: Record<string, string>) {
  Process.spawn = ((cmd: string[], ...rest: unknown[]) => {
    const clone = cmd[0] === "git" && cmd.includes("clone")
    if (!clone) return (originalSpawn as (...args: unknown[]) => unknown)(cmd, ...rest)
    const dest = cmd.at(-1)!
    const setup = (async () => {
      const { mkdir } = await import("fs/promises")
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dest, rel)
        await mkdir(path.dirname(abs), { recursive: true })
        await Filesystem.write(abs, content)
      }
      return 0
    })()
    return {
      exited: setup,
      stderr: new ReadableStream(),
    } as Process.Child
  }) as typeof Process.spawn
}

describe("SkillGithub.list", () => {
  test("lists skills from cloned repo", async () => {
    await using tmp = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = tmp.path
    mockClone({
      "foo/SKILL.md": `---\nname: foo-skill\ndescription: Foo skill\n---\n`,
      "foo/helper.txt": "helper",
      "bar/SKILL.md": `# no frontmatter`,
    })

    const result = await SkillGithub.list("acme", "skills")

    expect(result.branch).toBe("")
    expect(result.skills).toHaveLength(2)
    const foo = result.skills.find((s) => s.name === "foo")
    const bar = result.skills.find((s) => s.name === "bar")
    expect(foo).toMatchObject({ name: "foo", description: "Foo skill" })
    expect(bar).toMatchObject({ name: "bar", description: "" })
  })

  test("subpath narrows the list to skills under that directory", async () => {
    await using tmp = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = tmp.path
    mockClone({
      "skills/engineering/implement/SKILL.md": `---\nname: implement\ndescription: Impl\n---\n`,
      "skills/engineering/plan/SKILL.md": `---\nname: plan\n---\n`,
      "skills/writing/blog/SKILL.md": `---\nname: blog\n---\n`,
    })

    const result = await SkillGithub.list("https://github.com/acme/skills.git", { subpath: "skills/engineering" })

    const names = result.skills.map((s) => s.name).sort()
    expect(names).toEqual(["implement", "plan"])
    const impl = result.skills.find((s) => s.name === "implement")
    expect(impl?.description).toBe("Impl")
  })

  test("subpath pointing at a single skill directory lists only that skill", async () => {
    await using tmp = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = tmp.path
    mockClone({
      "skills/engineering/implement/SKILL.md": `---\nname: implement\n---\n`,
      "skills/engineering/plan/SKILL.md": `---\nname: plan\n---\n`,
    })

    const result = await SkillGithub.list("https://github.com/acme/skills.git", {
      subpath: "skills/engineering/implement",
    })

    expect(result.skills.map((s) => s.name)).toEqual(["implement"])
  })

  test("a root repo URL lists nested skills/**/SKILL.md recursively, not just one level", async () => {
    await using tmp = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = tmp.path
    mockClone({
      "skills/development/git-workflow/SKILL.md": `---\nname: git-workflow\ndescription: Git\n---\n`,
      "skills/ai-ml/prompt-eng/SKILL.md": `---\nname: prompt-eng\ndescription: Prompt\n---\n`,
      "README.md": "academy",
    })

    const result = await SkillGithub.list("https://gitee.com/acme/academy.git")

    const names = result.skills.map((s) => s.name).sort()
    expect(names).toEqual(["git-workflow", "prompt-eng"])
    expect(result.skills.find((s) => s.name === "git-workflow")?.description).toBe("Git")
    expect(result.skills.find((s) => s.name === "prompt-eng")?.description).toBe("Prompt")
  })

  // The repo-relative path lets the UI tell apart skills with the same name.
  test("list entries use the directory basename as name and the repo-relative directory as path", async () => {
    await using tmp = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = tmp.path
    mockClone({
      "skills/development/git-workflow/SKILL.md": `---\nname: git-workflow\n---\n`,
      "skills/ai-ml/prompt-eng/SKILL.md": `---\nname: prompt-eng\n---\n`,
      "SKILL.md": `---\nname: root-skill\n---\n`,
    })

    const result = await SkillGithub.list("https://gitee.com/acme/academy.git")

    const git = result.skills.find((s) => s.name === "git-workflow")
    const prompt = result.skills.find((s) => s.name === "prompt-eng")
    const root = result.skills.find((s) => s.name === "unknown")
    expect(git?.path).toBe("skills/development/git-workflow")
    expect(prompt?.path).toBe("skills/ai-ml/prompt-eng")
    expect(root?.path).toBe(".")
  })

  test("throws when no SKILL.md found", async () => {
    await using tmp = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = tmp.path
    mockClone({ "README.md": "hello" })

    await expect(SkillGithub.list("acme", "skills")).rejects.toThrow(/该仓库中未找到任何技能/)
  })

  test("throws for clone failure", async () => {
    const stderrText = "fatal: repository 'https://github.com/nonexistent/fake.git' not found"
    Process.spawn = (() => ({
      exited: Promise.resolve(1),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(stderrText))
          c.close()
        },
      }),
    })) as unknown as typeof Process.spawn

    await expect(SkillGithub.list("nonexistent", "fake")).rejects.toThrow(/仓库不存在/)
  })

  test("connection failure reports a network/proxy hint along with the raw git output", async () => {
    const stderrText =
      "Cloning into '...'\n" +
      "fatal: unable to access 'https://github.com/acme/skills.git/': Failed to connect to github.com port 443 after 21000 ms: Could not connect to server"
    Process.spawn = (() => ({
      exited: Promise.resolve(128),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(stderrText))
          c.close()
        },
      }),
    })) as unknown as typeof Process.spawn

    const err = await SkillGithub.list("https://github.com/acme/skills.git").catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/代理|网络/)
    expect(err.message).toMatch(/Failed to connect/)
  })

  test("clone is non-interactive: clears credential.helper, disables terminal/GCM prompts and ignores stdin", async () => {
    await using tmp = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = tmp.path
    let captured: { cmd: string[]; opts: Record<string, any> } | undefined
    Process.spawn = ((cmd: string[], opts: Record<string, any>) => {
      captured = { cmd, opts }
      const setup = (async () => {
        // Only write the placeholder skill for clone, so stray spawns never write files to a relative path.
        if (cmd.includes("clone")) {
          const { mkdir } = await import("fs/promises")
          const skillDir = path.join(cmd.at(-1)!, "foo")
          await mkdir(skillDir, { recursive: true })
          await Filesystem.write(path.join(skillDir, "SKILL.md"), `---\nname: foo\n---\n`)
        }
        return 0
      })()
      return { exited: setup, stderr: new ReadableStream() } as Process.Child
    }) as typeof Process.spawn

    await SkillGithub.list("acme", "skills")

    expect(captured?.cmd).toContain("credential.helper=")
    expect(captured?.cmd).toContain("clone")
    expect(captured?.opts?.stdin).toBe("ignore")
    expect(captured?.opts?.env?.GIT_TERMINAL_PROMPT).toBe("0")
    expect(captured?.opts?.env?.GCM_INTERACTIVE).toBe("never")
  })

  test("login/auth failure is classified as needing an access token and keeps the raw git output", async () => {
    const stderrText =
      "Cloning into '...'\n" + "fatal: could not read Username for 'https://gitee.com': terminal prompts disabled"
    Process.spawn = (() => ({
      exited: Promise.resolve(128),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(stderrText))
          c.close()
        },
      }),
    })) as unknown as typeof Process.spawn

    const err = await SkillGithub.list("https://gitee.com/x/y.git").catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/需要登录授权/)
    expect(err.message).toMatch(/访问令牌/)
    expect(err.message).not.toMatch(/仅支持公开仓库/)
    expect(err.message).toMatch(/could not read Username|terminal prompts disabled/)
  })

  test("gitee private repo (unable to get password) is classified as needing an access token", async () => {
    const stderrText = "Cloning into '...'\nfatal: unable to get password from user"
    Process.spawn = (() => ({
      exited: Promise.resolve(128),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(stderrText))
          c.close()
        },
      }),
    })) as unknown as typeof Process.spawn

    const err = await SkillGithub.list("https://gitee.com/hongmaple/agent-academy.git").catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/需要登录授权/)
    expect(err.message).toMatch(/访问令牌/)
    expect(err.message).not.toMatch(/仅支持公开仓库/)
    expect(err.message).toMatch(/unable to get password/)
  })

  test("clone timeout kills the git process and throws instead of hanging forever", async () => {
    await using tmp = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = tmp.path
    process.env.MERAKCODE_SKILL_CLONE_TIMEOUT_MS = "30"
    let killed = false
    Process.spawn = (() => ({
      exited: new Promise<number>(() => {}), // never settles, like a clone stuck on credentials or network
      stderr: new ReadableStream(),
      kill: () => {
        killed = true
      },
    })) as unknown as typeof Process.spawn

    try {
      const err = await SkillGithub.list("acme", "skills").catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/超时/)
      expect(killed).toBe(true)
    } finally {
      delete process.env.MERAKCODE_SKILL_CLONE_TIMEOUT_MS
    }
  })

  test("auth is injected as http.extraHeader via GIT_CONFIG, keeping the token out of argv", async () => {
    await using tmp = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = tmp.path
    let captured: { cmd: string[]; opts: Record<string, any> } | undefined
    Process.spawn = ((cmd: string[], opts: Record<string, any>) => {
      captured = { cmd, opts }
      const setup = (async () => {
        // Only write the placeholder skill for clone, so stray spawns never write files to a relative path.
        if (cmd.includes("clone")) {
          const { mkdir } = await import("fs/promises")
          const skillDir = path.join(cmd.at(-1)!, "foo")
          await mkdir(skillDir, { recursive: true })
          await Filesystem.write(path.join(skillDir, "SKILL.md"), `---\nname: foo\n---\n`)
        }
        return 0
      })()
      return { exited: setup, stderr: new ReadableStream() } as Process.Child
    }) as typeof Process.spawn

    await SkillGithub.list("https://gitee.com/o/r.git", { auth: { token: "T0KEN", username: "me" } })

    expect(captured?.cmd.join(" ")).not.toContain("T0KEN")
    expect(captured?.opts?.env?.GIT_CONFIG_COUNT).toBe("1")
    expect(captured?.opts?.env?.GIT_CONFIG_KEY_0).toBe("http.extraHeader")
    expect(captured?.opts?.env?.GIT_CONFIG_VALUE_0).toContain(`Basic ${btoa("me:T0KEN")}`)
  })
})

describe("SkillGithub.cleanup", () => {
  test("does not throw when directory does not exist", async () => {
    await expect(SkillGithub.cleanup("acme", "skills")).resolves.toBeUndefined()
  })
})
