import { writeFile } from "node:fs/promises"
import path from "node:path"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { buffersFor, releaseBuffers } from "./state"
import { readDraft, writeDraft } from "./draft"

// The code editor is a browser component; a plain text model stands in for it. Everything else is real.
vi.mock("../../lib/monaco", () => ({
  monaco: {
    Uri: { parse: (value: string) => value },
    editor: {
      createModel: (initial: string) => {
        let value = initial
        const listeners: Array<() => void> = []
        return {
          getValue: () => value,
          setValue: (next: string) => {
            value = next
            listeners.forEach((fn) => fn())
          },
          onDidChangeContent: (fn: () => void) => listeners.push(fn),
          dispose() {},
        }
      },
    },
  },
}))

const writePlan = (content: string) => ({
  calls: [{ id: crypto.randomUUID(), name: "write_plan", input: { content } }],
})
const PLANS = 5
let env: Awaited<ReturnType<typeof engineFixture>>
const sessions: string[] = []
let child = ""

beforeAll(async () => {
  // Replies are consumed in order: one plan per session, then a child that is spawned, then plain answers.
  env = await engineFixture({
    replies: [
      ...Array.from({ length: PLANS }, (_, index) => writePlan(`# Plan ${index}\n1. Step`)),
      { calls: [{ id: crypto.randomUUID(), name: "spawn", input: { prompt: "Look around" } }] },
      ...Array.from({ length: 40 }, () => ({ text: "Done" })),
    ],
  })
  location.href = env.url
  await writeFile(path.join(env.project, "notes.txt"), "notes\n")
  await env.git("add", ".")
  await env.git("commit", "-m", "initial")
  const connection = await client()
  for (let index = 0; index < PLANS; index++) {
    const created = await connection.session.create({ provider: "fake", model: "test", workdir: env.project })
    await connection.session.send({ session: created.session, parts: [{ text: "Plan it" }], plan: true })
    await vi.waitFor(() => connection.plan.get({ session: created.session }), { timeout: 20_000 })
    sessions.push(created.session)
  }
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})

const planOf = async (session: string) => (await client()).plan.get({ session })

test("plans and physical files with the same display name keep separate buffers and drafts", async () => {
  const session = sessions[0]!
  const name = `Plan-${session}.md`
  await writeFile(path.join(env.project, name), "physical file\n")
  const buffer = buffersFor(env.project)
  try {
    await buffer.open(name)
    await buffer.open(name, session)
    expect(buffer.tabs).toHaveLength(2)
    const file = buffer.tabs.find((tab) => !tab.planSessionID)!
    const plan = buffer.tabs.find((tab) => !!tab.planSessionID)!
    expect(file.saved).toBe("physical file\n")
    expect(plan.saved).toBe((await planOf(session)).content)
    file.model!.setValue("Physical draft")
    plan.model!.setValue("Official plan draft")
    await buffer.suspend(file.path, "file")
    await buffer.suspend(plan.path, "plan")
    expect(await readDraft(env.project, file.path)).toMatchObject({ content: "Physical draft" })
    expect(await readDraft(env.project, plan.path)).toMatchObject({ content: "Official plan draft" })
    await buffer.close(file.path)
    await buffer.close(plan.path)
  } finally {
    releaseBuffers(env.project)
  }
})

test("execution refuses to continue when a persisted plan draft cannot be loaded", async () => {
  const session = sessions[1]!
  const root = (await planOf(session)).session
  const buffer = buffersFor(env.project)
  const missing = "ses_deleted_child"
  const path = `merakcode-plan://${encodeURIComponent(missing)}/Plan-${missing}.md`
  try {
    // A suspended editor of a conversation that belongs to this plan but can no longer be read.
    await writeDraft(env.project, path, {
      content: "Do not execute the old plan",
      saved: "old",
      planSessionID: missing,
      planRootSessionID: root,
    })
    expect(await buffer.savePlan(session)).toBe(false)
    expect(await readDraft(env.project, path)).toMatchObject({ content: "Do not execute the old plan" })
    expect(buffer.errors[path]).toBeTruthy()
    expect((await planOf(session)).content).not.toContain("Do not execute")
    await writeDraft(env.project, path)
  } finally {
    releaseBuffers(env.project)
  }
})

test("executing a plan saves the editor draft after its view has unmounted", async () => {
  const session = sessions[2]!
  const buffer = buffersFor(env.project)
  try {
    await buffer.open(`Plan-${session}.md`, session)
    buffer.tabs[0]!.model!.setValue("Suspended human plan")
    await buffer.suspend(buffer.tabs[0]!.path, "view")
    expect(buffer.tabs).toHaveLength(0)
    const before = (await planOf(session)).revision
    expect(await buffer.savePlan(session)).toBe(true)
    expect(await planOf(session)).toMatchObject({ content: "Suspended human plan", revision: before + 1 })
    expect(await readDraft(env.project, `merakcode-plan://${encodeURIComponent(session)}/Plan-${session}.md`)).toBe(
      undefined,
    )
  } finally {
    releaseBuffers(env.project)
  }
})

test("saving a plan keeps its response revision paired with the submitted content", async () => {
  const session = sessions[3]!
  const buffer = buffersFor(env.project)
  try {
    await buffer.open(`Plan-${session}.md`, session)
    const first = await planOf(session)
    expect(buffer.tabs[0]!.checksum).toBe(String(first.revision))
    buffer.tabs[0]!.model!.setValue("Human A")
    await buffer.save(false, buffer.tabs[0]!.path)
    expect(buffer.tabs[0]).toMatchObject({ saved: "Human A", checksum: String(first.revision + 1), dirty: false })
    expect(await planOf(session)).toMatchObject({ content: "Human A", revision: first.revision + 1 })
    const other = await (await client()).plan.save({ session, content: "Human B", revision: first.revision + 1 })
    await buffer.reload()
    expect(buffer.tabs[0]!.saved).toBe("Human B")
    expect(buffer.tabs[0]!.model!.getValue()).toBe("Human B")
    expect(buffer.tabs[0]!.checksum).toBe(String(other.revision))
  } finally {
    releaseBuffers(env.project)
  }
})

test("starting a root plan saves a suspended child editor through its owning session", async () => {
  const root = sessions[4]!
  const connection = await client()
  await connection.session.send({ session: root, parts: [{ text: "Look into it" }] })
  await expect
    .poll(async () => ((await connection.session.list()) ?? []).some((info) => info.config.parent === root), {
      timeout: 20_000,
    })
    .toBe(true)
  child = ((await connection.session.list()) ?? []).find((info) => info.config.parent === root)!.id
  const buffer = buffersFor(env.project)
  try {
    await buffer.open(`Plan-${child}.md`, child)
    const path = buffer.tabs[0]!.path
    expect(buffer.tabs[0]!.planRootSessionID).toBe(root)
    buffer.tabs[0]!.model!.setValue("Child human plan")
    await buffer.suspend(path, "view")
    const before = (await planOf(root)).revision
    expect(await buffer.savePlan(root)).toBe(true)
    expect(await planOf(root)).toMatchObject({ content: "Child human plan", revision: before + 1 })
    expect(await planOf(child)).toMatchObject({ session: root, content: "Child human plan" })
  } finally {
    releaseBuffers(env.project)
  }
})
