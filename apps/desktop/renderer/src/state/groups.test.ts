import { afterAll, beforeAll, expect, test } from "vitest"
import type { EngineEvent, GroupGroup } from "@merakcode/sdk"
import { engineFixture } from "../test/engine"
import { client } from "./client"
import { connect, ensureSession, state } from "./store"
import { connectGroups, groups, groupView, loadGroup, loadGroups, localHuman, receiveGroupEvent } from "./groups"

let engine: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  engine = await engineFixture()
  location.href = engine.url
  await engine.git("commit", "--allow-empty", "-m", "Fixture")
})
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await engine.close()
  }
})

async function newGroup(name: string): Promise<GroupGroup> {
  const connection = await client()
  return connection.group.create({
    id: "",
    kind: "local",
    name,
    project: { directory: engine.project },
    leader: "leader",
    members: [
      { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
      { id: "leader", group: "", kind: "agent", name, agentRole: "leader", agent: "builtin-merakcode", status: "idle" },
    ],
  })
}

async function fill(group: GroupGroup, count: number) {
  const connection = await client()
  for (let from = 0; from < count; from += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, count - from) }, (_, index) =>
        connection.event.emit({ group: group.id, type: "external.note", payload: { index: from + index } }),
      ),
    )
  }
}

test("three groups with two thousand events each appear in the sidebar list within two seconds of startup", async () => {
  // The hello greeting holds the person every call acts as
  await client()
  const created = [await newGroup("Alpha"), await newGroup("Beta"), await newGroup("Gamma")]
  for (const group of created) await fill(group, 2000)
  const started = performance.now()
  await loadGroups()
  expect(
    groups()
      .map((group) => group.name)
      .toSorted(),
  ).toEqual(["Alpha", "Beta", "Gamma"])
  expect(performance.now() - started).toBeLessThan(2000)
  // The histories follow in the background
  for (const group of created)
    await expect.poll(() => groupView(group.id)?.lastSeq ?? 0, { timeout: 30000 }).toBeGreaterThan(2000)
}, 120000)

test("a group whose fold fails is rebuilt alone while the connection and the other groups keep running", async () => {
  const stopStore = connect()
  const stopGroups = connectGroups()
  try {
    const connection = await client()
    const [broken, healthy] = [await newGroup("Broken"), await newGroup("Healthy")]
    await Promise.all([loadGroup(broken.id), loadGroup(healthy.id)])
    await expect.poll(() => state.connected).toBe(true)
    const conversation = await connection.session.create({
      provider: "fake",
      model: "fixture",
      workdir: engine.project,
    })
    await ensureSession(conversation.session)
    const before = groupView(broken.id)!.lastSeq
    const forged = {
      id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
      stream: `group:${broken.id}`,
      scope: { group: broken.id, task: "forged" },
      time: new Date().toISOString(),
      seq: before + 1,
      actor: { kind: "human", id: localHuman },
      type: "task.created",
      payload: { id: "forged", title: "Forged", status: "bogus", priority: 0, project: engine.project },
    } as unknown as EngineEvent
    receiveGroupEvent(forged)
    await expect.poll(() => groupView(broken.id)?.lastSeq, { timeout: 10000 }).toBe(before)
    expect(groupView(broken.id)?.events.some((event) => event.id === forged.id)).toBe(false)
    expect(Object.values(groupView(broken.id)!.board.columns).flat()).toHaveLength(0)
    // The rebuilt group follows the engine again
    await connection.event.emit({ group: broken.id, type: "external.note", payload: { after: true } })
    await expect
      .poll(() => groupView(broken.id)?.events.some((event) => event.type === "external.note"), { timeout: 10000 })
      .toBe(true)
    // The other group and the conversation stream are untouched
    const same = await client()
    expect(same).toBe(connection)
    await connection.event.emit({ group: healthy.id, type: "external.note", payload: {} })
    await expect.poll(() => groupView(healthy.id)?.events.some((event) => event.type === "external.note")).toBe(true)
    await connection.session.send({ session: conversation.session, parts: [{ text: "still streaming" }] })
    await expect
      .poll(() => JSON.stringify(state.views[conversation.session]?.state.messages), { timeout: 10000 })
      .toContain("Feedback received")
    expect(state.connected).toBe(true)
  } finally {
    stopGroups()
    stopStore()
  }
}, 60000)

test("a group view keeps following its group after the connection to the engine is lost and comes back", async () => {
  const stopStore = connect()
  const stopGroups = connectGroups()
  try {
    // The connection of the previous test is closing; wait for one that works
    await expect
      .poll(
        () =>
          client().then((live) =>
            live.group.list().then(
              () => true,
              () => false,
            ),
          ),
        { timeout: 15000 },
      )
      .toBe(true)
    const group = await newGroup("Reconnect")
    await loadGroup(group.id)
    const first = await client()
    await first.close()
    await expect.poll(async () => (await client()) !== first, { timeout: 15000 }).toBe(true)
    const connection = await client()
    await connection.event.emit({ group: group.id, type: "external.note", payload: { after: "reconnect" } })
    await expect
      .poll(() => groupView(group.id)?.events.some((event) => event.type === "external.note"), { timeout: 15000 })
      .toBe(true)
  } finally {
    stopGroups()
    stopStore()
  }
}, 60000)
