import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { DelegateTool } from "../../src/tool/delegate"
import { create, load } from "../../src/collaboration/store"
import { leaderContext } from "../../src/collaboration/context"
import { tmpdir } from "../fixture/fixture"

const FIXTURE = path.join(import.meta.dirname, "fixture", "adapter.ts")

/**
 * A member in a new group, working through the fixture adapter with this scenario (or the one made for the project
 * directory); metadata gets each update
 */
async function delegate(
  scenario: object | ((project: string) => object),
  metadata: (value: Record<string, unknown>) => void = () => {},
) {
  await using tmp = await tmpdir({
    git: true,
    init: (dir) => {
      const made = typeof scenario === "function" ? scenario(dir) : scenario
      const fake = {
        title: "Fake",
        adapter: "member",
        command: process.execPath,
        args: [...process.execArgv, FIXTURE, JSON.stringify(made)],
      }
      return fs.writeFile(path.join(dir, "merakcode.json"), JSON.stringify({ collaboration: { products: { fake } } }))
    },
  })
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ metadata: { group: true } })
      await create(session.id, { leader: { name: "小主" }, seats: [{ name: "小红", product: "fake" }] })
      const tool = await DelegateTool.init()
      const done = await tool.execute(
        { seat: "小红", task: "写需求" },
        {
          sessionID: session.id,
          messageID: Identifier.ascending("message"),
          callID: "call",
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          ruleset: [],
          metadata: (value) => metadata((value.metadata ?? {}) as Record<string, unknown>),
          ask: async () => {},
        },
      )
      return { done, context: await leaderContext(session.id), group: await load(session.id) }
    },
  })
}

test("a member's steps reach the chat while it is still working", async () => {
  await using gates = await tmpdir()
  const gate = (n: number) => path.join(gates.path, `go${n}`)
  const steps: unknown[] = []
  const running = delegate(
    {
      steps: [
        { tool: "Bash", detail: "node --version", gate: gate(1) },
        { tool: "Write", detail: "docs/prd.md", gate: gate(2) },
      ],
      reply: "写好了",
    },
    (metadata) => {
      const list = metadata.steps as unknown[] | undefined
      if (list) steps.splice(0, steps.length, ...list)
    },
  )
  await expect.poll(() => steps, { timeout: 20_000 }).toEqual([{ tool: "Bash", detail: "node --version" }])
  await fs.writeFile(gate(1), "")
  await expect
    .poll(() => steps)
    .toEqual([
      { tool: "Bash", detail: "node --version" },
      { tool: "Write", detail: "docs/prd.md" },
    ])
  await fs.writeFile(gate(2), "")
  const { done, context, group } = await running
  expect(done.output).toBe("写好了")
  expect(done.metadata).toMatchObject({ steps })
  // The steps are for the chat only: the leader's context and the record do not carry them
  expect(JSON.stringify({ context, group })).not.toContain("node --version")
}, 60_000)

test("a path in the project a member reports is shown relative to it; other details as they are", async () => {
  let outside = ""
  const { done } = await delegate((project) => {
    outside = path.join(path.dirname(project), "elsewhere.txt")
    return {
      steps: [
        { tool: "edit", detail: path.join(project, "src", "a.ts") },
        { tool: "read", detail: outside },
        { tool: "bash", detail: "npm test" },
        { tool: "webfetch", detail: "https://example.com/a" },
      ],
      reply: "好了",
    }
  })
  expect((done.metadata as { steps: { detail: string }[] }).steps.map((step) => step.detail)).toEqual([
    "src/a.ts",
    outside,
    "npm test",
    "https://example.com/a",
  ])
}, 60_000)

test("a member that works for long keeps its last fifty steps", async () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ tool: "Bash", detail: `step ${index + 1}` }))
  const { done } = await delegate({ steps: many, reply: "跑完了" })
  const steps = (done.metadata as { steps: { detail: string }[] }).steps
  expect(steps).toHaveLength(50)
  expect(steps[0]!.detail).toBe("step 11")
  expect(steps.at(-1)!.detail).toBe("step 60")
}, 60_000)
