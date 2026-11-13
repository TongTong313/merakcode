import { afterAll, beforeAll, expect, test } from "vitest"
import { engineFixture } from "../test/engine"
import { client } from "./client"
import { archivedTasks, claimOrigin, connectTasks, createdAt, loadTasks, taskUpdated, tasks } from "./tasks"
import { connect } from "./store"

let engine: Awaited<ReturnType<typeof engineFixture>>
let stop = () => {}
beforeAll(async () => {
  engine = await engineFixture()
  location.href = engine.url
  await engine.git("commit", "--allow-empty", "-m", "Fixture")
  const stopStore = connect()
  const stopTasks = connectTasks()
  stop = () => {
    stopTasks()
    stopStore()
  }
  await client()
})
afterAll(async () => {
  stop()
  await engine.close()
})

test("the task list holds every task of the client and follows task events", async () => {
  const connection = await client()
  const first = await connection.task.create({ title: "Written before the list loads", project: engine.project })
  await loadTasks()
  expect(tasks().map((card) => card.id)).toContain(first.id)
  const second = await connection.task.create({ title: "Written while watching", project: engine.project })
  await expect.poll(() => tasks().map((card) => card.id), { timeout: 10000 }).toContain(second.id)
  await connection.task.cancel({ task: second.id })
  await expect.poll(() => tasks().find((card) => card.id === second.id)?.status, { timeout: 10000 }).toBe("cancelled")
  expect(taskUpdated(second.id)).toBeGreaterThanOrEqual(createdAt(second.id))
  expect(createdAt(first.id)).toBeGreaterThan(Date.now() - 60_000)
})

test("an archived task leaves the list for the archive and comes back when restored", async () => {
  const connection = await client()
  const card = await connection.task.create({ title: "Finished work", project: engine.project })
  await connection.task.cancel({ task: card.id })
  await loadTasks()
  await connection.task.archive({ tasks: [card.id], archived: true })
  await expect.poll(() => tasks().some((item) => item.id === card.id), { timeout: 10000 }).toBe(false)
  await expect.poll(() => archivedTasks().some((item) => item.id === card.id), { timeout: 10000 }).toBe(true)
  await connection.task.archive({ tasks: [card.id], archived: false })
  await expect.poll(() => tasks().some((item) => item.id === card.id), { timeout: 10000 }).toBe(true)
  expect(archivedTasks().some((item) => item.id === card.id)).toBe(false)
})

test("a claim a worker took by itself is told apart from one it was given", async () => {
  const connection = await client()
  const agents = (await connection.agent.list({}))!
  const worker = await connection.agent.save({
    agent: { ...agents[0]!, id: "", name: "Taker", model: { provider: "fake", model: "fixture" } },
  })
  const lead = await connection.agent.save({
    agent: { ...agents[0]!, id: "", name: "Chief", model: { provider: "fake", model: "fixture" } },
  })
  const human = connection.hello.human
  const group = await connection.group.create({
    id: "",
    kind: "local",
    name: "Claims",
    project: { directory: engine.project },
    leader: "chief",
    members: [
      { id: human, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
      {
        id: "chief",
        group: "",
        kind: "agent",
        name: "Chief",
        agentRole: "leader",
        agent: lead.id,
        owner: human,
        status: "idle",
      },
      {
        id: "taker",
        group: "",
        kind: "agent",
        name: "Taker",
        agentRole: "worker",
        agent: worker.id,
        owner: human,
        status: "idle",
      },
    ],
  })
  const card = await connection.task.create({ group: group.id, title: "Given work" })
  const claim = await connection.task.assign({ task: card.id, member: "taker" })
  await expect.poll(() => claimOrigin(claim.id), { timeout: 10000 }).toBe("assigned")
  expect(claimOrigin("unknown")).toBeUndefined()
})
