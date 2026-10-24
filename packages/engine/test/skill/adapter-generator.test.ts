import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { BUILTIN_SKILLS } from "@merakcode/engine/skill/builtin/index"
import { getBuiltinSkill } from "@merakcode/engine/skill/builtin"
import { inspectMember, runMember } from "@merakcode/engine/collaboration/member"
import { Instance } from "@merakcode/engine/project/instance"
import { SkillTool } from "@merakcode/engine/tool/skill"
import { BashTool } from "@merakcode/engine/tool/bash"
import { tmpdir } from "../fixture/fixture"
import { shim } from "../collaboration/fixture/shim"

const skill = getBuiltinSkill("adapter-generator")

test("the adapter generator is a built-in skill, and auto-cli is gone", () => {
  expect(skill?.name).toBe("adapter-generator")
  expect(skill?.description).toMatch(/adapter/i)
  expect(Object.keys(BUILTIN_SKILLS)).not.toContain("auto-cli")
})

/** The examples, each MerakCode's own adapter for a CLI that talks in one of the three ways, and that CLI's fake */
const EXAMPLES = [
  {
    file: "example-claude-code.mts",
    cli: "claude",
    env: { CLAUDE_FIXTURE: JSON.stringify([{ name: "Bash", input: { command: "npm test" } }]) },
  },
  {
    file: "example-codex.mts",
    cli: "codex",
    env: { CODEX_FIXTURE: JSON.stringify([{ type: "command", command: "npm test" }]) },
  },
  {
    file: "example-opencode.mts",
    cli: "opencode",
    env: {
      OPENCODE_FIXTURE: JSON.stringify([
        { permission: "bash", patterns: ["npm test"], metadata: { command: "npm test" } },
      ]),
    },
  },
]

for (const example of EXAMPLES)
  test(`${example.file}, next to the library in an empty folder, runs its CLI and asks MerakCode before a command`, async () => {
    const files = skill?.files ?? {}
    await using tmp = await tmpdir()
    // As the skill tells the model to do: the library, and the example as the adapter
    for (const file of ["merakcode-adapter.mjs", "merakcode-adapter.d.mts"])
      await fs.writeFile(path.join(tmp.path, file), files[file]!)
    await fs.writeFile(path.join(tmp.path, "adapter.mts"), files[example.file]!)
    // The CLI as npm installs it: a .cmd shim on Windows
    const command = await shim(tmp.path, example.cli, `${example.cli}.ts`)
    const product = { id: example.cli, title: example.cli, command, args: [] }
    const launch = [process.execPath, path.join(tmp.path, "adapter.mts")]
    const saved = Object.fromEntries(Object.keys(example.env).map((key) => [key, process.env[key]]))
    Object.assign(process.env, example.env)
    try {
      expect((await inspectMember({ launch, product, cwd: tmp.path })).version).toBeTruthy()
      const asked: unknown[] = []
      const result = await runMember({
        launch,
        product,
        task: { prompt: "做登录", cwd: tmp.path, mode: "ask" },
        abort: new AbortController().signal,
        host: {
          step: () => {},
          permission: async (request) => {
            asked.push(request)
            return { allow: true }
          },
          question: async () => [],
        },
      })
      expect(asked).toEqual([{ kind: "command", command: "npm test" }])
      expect(result.text).toBeTruthy()
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
  }, 60_000)

test("an adapter written in plain JavaScript beside the library still runs, as ones written before TypeScript do", async () => {
  await using tmp = await tmpdir()
  await fs.writeFile(path.join(tmp.path, "merakcode-adapter.mjs"), skill?.files?.["merakcode-adapter.mjs"] ?? "")
  await fs.writeFile(
    path.join(tmp.path, "adapter.mjs"),
    `import { adapter } from "./merakcode-adapter.mjs"
adapter({
  inspect: () => ({ name: "Plain", version: "1.0.0" }),
  async run(task, host) {
    const verdict = await host.permission({ kind: "command", command: "npm test" })
    return { text: task.prompt + " " + verdict.allow }
  },
})
`,
  )
  const asked: unknown[] = []
  const result = await runMember({
    launch: [process.execPath, path.join(tmp.path, "adapter.mjs")],
    product: { id: "plain", title: "Plain" },
    task: { prompt: "做登录", cwd: tmp.path, mode: "ask" },
    abort: new AbortController().signal,
    host: {
      step: () => {},
      permission: async (request) => {
        asked.push(request)
        return { allow: true }
      },
      question: async () => [],
    },
  })
  expect(asked).toEqual([{ kind: "command", command: "npm test" }])
  expect(result.text).toBe("做登录 true")
}, 60_000)

test("every file the skill names is one it carries, and each it carries is named", () => {
  // adapter.mts is the one the model writes
  const named = new Set(skill?.content.match(/\b[\w-]+(?:\.d)?\.m[jt]s\b/g)?.filter((file) => file !== "adapter.mts"))
  expect([...named].sort()).toEqual(Object.keys(skill?.files ?? {}).sort())
})

test("the skill names the global config file, and has the library copied with a shell command", () => {
  // The global config is merakcode.jsonc in the MerakCode home, or merakcode.json when that is the one there
  expect(skill?.content).toContain("`merakcode.jsonc`")
  expect(skill?.content).toContain("`merakcode.json`")
  expect(skill?.content).toMatch(/\bcp\b/)
})

test("loading the skill lists each of its files on disk too, for the model to copy rather than write out", async () => {
  await using tmp = await tmpdir({ git: true })
  const ctx = {
    sessionID: "test",
    messageID: "",
    callID: "",
    agent: "build",
    kind: "ask" as const,
    abort: new AbortController().signal,
    messages: [],
    ruleset: [],
    metadata: () => {},
    ask: async () => {},
  }
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { output } = await (await SkillTool.init()).execute({ name: "adapter-generator" }, ctx)
      const onDisk = [...output.matchAll(/<file>([^<]+)<\/file>/g)]
        .map((match) => match[1]!)
        .filter((file) => !file.startsWith("builtin-skill://"))
      expect(onDisk.map((file) => path.basename(file)).sort()).toEqual(Object.keys(skill?.files ?? {}).sort())
      // As the model copies them: the listed path, unquoted, in a command of MerakCode's own shell
      const bash = await BashTool.init()
      for (const file of onDisk)
        await bash.execute({ command: `cp ${file} copied-${path.basename(file)}`, description: "Copy a file" }, ctx)
    },
  })
  for (const [file, text] of Object.entries(skill?.files ?? {}))
    expect(await fs.readFile(path.join(tmp.path, `copied-${file}`), "utf8")).toBe(text)
}, 60_000)
