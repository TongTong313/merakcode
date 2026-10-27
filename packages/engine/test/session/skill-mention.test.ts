import { afterEach, expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Instance } from "@merakcode/engine/project/instance"
import { Plugin } from "@merakcode/engine/plugin/index"
import { Provider } from "@merakcode/engine/provider/provider"
import { Message } from "@merakcode/engine/session/message"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { Session } from "@merakcode/engine/session/index"
import { tmpdir } from "../fixture/fixture"

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

/** Stops once the user message is assembled, before the model runs. */
async function capturePrompt(input: Parameters<typeof SessionRunner.prompt>[0]): Promise<Message.FullMsg> {
  const stop = new Error("captured prompt before the model")
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
    await expect(SessionRunner.prompt(input)).rejects.toBe(stop)
  } finally {
    Plugin.trigger = original
  }
  if (!captured) throw new Error("prompt did not reach chat.message")
  return captured
}

test("loading a /name includes the skill directory and its other files", async () => {
  await using tmp = await tmpdir({ git: true })
  const skillDir = path.join(tmp.path, ".claude", "skills", "tdd")
  await Filesystem.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: tdd
description: Test-driven development.
---

CLAUDE-SKILL-BODY
`,
  )
  await Filesystem.write(path.join(skillDir, "tests.md"), "how to write the test\n")
  const home = process.env.MERAKCODE_TEST_HOME
  process.env.MERAKCODE_TEST_HOME = tmp.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await capturePrompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          parts: [{ type: "text", text: "请按 /tdd 做这件事" }],
        })
        const text = user.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        expect(text).toContain("tests.md")
        expect(text).toContain("Base directory for this skill:")
      },
    })
  } finally {
    if (home === undefined) delete process.env.MERAKCODE_TEST_HOME
    else process.env.MERAKCODE_TEST_HOME = home
  }
}, 20000)

test("a /name after a space loads skills from .merakcode/skills and .merakcode/skill", async () => {
  await using tmp = await tmpdir({ git: true })
  await Filesystem.write(
    path.join(tmp.path, ".merakcode", "skills", "review", "SKILL.md"),
    `---
name: review
description: Review a change.
---

MERAK-PLURAL-BODY
`,
  )
  await Filesystem.write(
    path.join(tmp.path, ".merakcode", "skill", "release", "SKILL.md"),
    `---
name: release
description: Cut a release.
---

MERAK-SINGULAR-BODY
`,
  )
  const home = process.env.MERAKCODE_TEST_HOME
  process.env.MERAKCODE_TEST_HOME = tmp.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await capturePrompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          parts: [{ type: "text", text: "先 /review 再 /release" }],
        })
        const text = user.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        expect(text).toContain("先 /review 再 /release")
        expect(text).toContain("MERAK-PLURAL-BODY")
        expect(text).toContain("MERAK-SINGULAR-BODY")
      },
    })
  } finally {
    if (home === undefined) delete process.env.MERAKCODE_TEST_HOME
    else process.env.MERAKCODE_TEST_HOME = home
  }
}, 20000)

test("a whole /name message with a task includes the skill and tells the model to follow it", async () => {
  await using tmp = await tmpdir({ git: true })
  await Filesystem.write(
    path.join(tmp.path, ".merakcode", "skill", "tdd", "SKILL.md"),
    `---
name: tdd
description: Test-driven development.
---

CLAUDE-SKILL-BODY
`,
  )
  const home = process.env.MERAKCODE_TEST_HOME
  process.env.MERAKCODE_TEST_HOME = tmp.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { template, system } = await SessionRunner.resolveCommandInjection({
          command: "tdd",
          arguments: "帮我写测试",
        })
        expect(template).toContain("帮我写测试")
        expect(system).toContain("CLAUDE-SKILL-BODY")
        expect(system).toContain("Follow this skill")
      },
    })
  } finally {
    if (home === undefined) delete process.env.MERAKCODE_TEST_HOME
    else process.env.MERAKCODE_TEST_HOME = home
  }
}, 20000)

test("a denied skill is not loaded when the message names it with /name", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      agent: { build: { permission: { skill: { tdd: "deny" } } } },
    } as never,
  })
  await Filesystem.write(
    path.join(tmp.path, ".claude", "skills", "tdd", "SKILL.md"),
    `---
name: tdd
description: Test-driven development.
---

CLAUDE-SKILL-BODY
`,
  )
  const home = process.env.MERAKCODE_TEST_HOME
  process.env.MERAKCODE_TEST_HOME = tmp.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await capturePrompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          parts: [{ type: "text", text: "请按 /tdd 做这件事" }],
        })
        const text = user.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        expect(text).toContain("请按 /tdd 做这件事")
        expect(text).not.toContain("CLAUDE-SKILL-BODY")
      },
    })
  } finally {
    if (home === undefined) delete process.env.MERAKCODE_TEST_HOME
    else process.env.MERAKCODE_TEST_HOME = home
  }
}, 20000)

test("a whole /name command does not load a skill the agent is denied", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      agent: { build: { permission: { skill: { tdd: "deny" } } } },
    } as never,
  })
  await Filesystem.write(
    path.join(tmp.path, ".merakcode", "skill", "tdd", "SKILL.md"),
    `---
name: tdd
description: Test-driven development.
---

CLAUDE-SKILL-BODY
`,
  )
  const home = process.env.MERAKCODE_TEST_HOME
  process.env.MERAKCODE_TEST_HOME = tmp.path
  Provider.getModel = (async () => testModel) as typeof Provider.getModel
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const stop = new Error("captured command before the model")
        let captured: Message.FullMsg | undefined
        const original = Plugin.trigger
        Plugin.trigger = (async (name, _input, output) => {
          if (name === "chat.message") {
            const data = output as { message: Message.UserInfo; parts: Message.Part[] }
            captured = { info: data.message, parts: data.parts }
            throw stop
          }
          return output
        }) as typeof Plugin.trigger
        try {
          await expect(
            SessionRunner.command({
              sessionID: session.id,
              command: "tdd",
              arguments: "帮我写测试",
              agent: "build",
              model: "openai/gpt-4",
            }),
          ).rejects.toBe(stop)
        } finally {
          Plugin.trigger = original
        }
        if (!captured || captured.info.role !== "user" || Message.isExternal(captured.info))
          throw new Error("command did not reach chat.message")
        const text = captured.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        expect(text).toContain("帮我写测试")
        expect(text).not.toContain("CLAUDE-SKILL-BODY")
        expect(captured.info.system ?? "").not.toContain("CLAUDE-SKILL-BODY")
      },
    })
  } finally {
    if (home === undefined) delete process.env.MERAKCODE_TEST_HOME
    else process.env.MERAKCODE_TEST_HOME = home
  }
}, 20000)

test("a slash inside a path or URL, or an unknown /word, does not load a skill", async () => {
  await using tmp = await tmpdir({ git: true })
  await Filesystem.write(
    path.join(tmp.path, ".claude", "skills", "tdd", "SKILL.md"),
    `---
name: tdd
description: Test-driven development.
---

CLAUDE-SKILL-BODY
`,
  )
  const home = process.env.MERAKCODE_TEST_HOME
  process.env.MERAKCODE_TEST_HOME = tmp.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await capturePrompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          parts: [{ type: "text", text: "打开 https://example.com/tdd 和 foo/tdd 以及 /missing" }],
        })
        const text = user.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        expect(text).toContain("https://example.com/tdd")
        expect(text).not.toContain("CLAUDE-SKILL-BODY")
      },
    })
  } finally {
    if (home === undefined) delete process.env.MERAKCODE_TEST_HOME
    else process.env.MERAKCODE_TEST_HOME = home
  }
}, 20000)

test("a /name after a space loads that skill from .claude/skills and keeps the rest of the message", async () => {
  await using tmp = await tmpdir({ git: true })
  await Filesystem.write(
    path.join(tmp.path, ".claude", "skills", "tdd", "SKILL.md"),
    `---
name: tdd
description: Test-driven development.
---

CLAUDE-SKILL-BODY
`,
  )
  const home = process.env.MERAKCODE_TEST_HOME
  process.env.MERAKCODE_TEST_HOME = tmp.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await capturePrompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          parts: [{ type: "text", text: "请按 /tdd 做这件事" }],
        })
        const text = user.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        expect(text).toContain("请按 /tdd 做这件事")
        expect(text).toContain("CLAUDE-SKILL-BODY")
      },
    })
  } finally {
    if (home === undefined) delete process.env.MERAKCODE_TEST_HOME
    else process.env.MERAKCODE_TEST_HOME = home
  }
}, 20000)
