import { afterAll, beforeAll, expect, test } from "vitest"
import { engineFixture } from "../test/engine"
import { client } from "./client"
import { deleteSession, ensureSession, hideSession, setState, state } from "./store"

let engine: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  engine = await engineFixture()
  location.href = engine.url
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await engine.close()
  }
})

const create = async () => {
  const connection = await client()
  const created = await connection.session.create({ provider: "fake", model: "test", workdir: engine.project })
  setState("sessions", (await connection.session.list()) ?? [])
  await ensureSession(created.session)
  return created.session
}

test("deleting a conversation removes it from the engine and from every list the window keeps", async () => {
  const id = await create()
  const other = await create()
  expect(state.sessions.some((info) => info.id === id)).toBe(true)

  await deleteSession(id)

  const listed = (await (await client()).session.list()) ?? []
  expect(listed.some((info) => info.id === id)).toBe(false)
  expect(listed.some((info) => info.id === other)).toBe(true)
  expect(state.sessions.some((info) => info.id === id)).toBe(false)
  expect(state.views[id]).toBeUndefined()
  expect(state.hidden).toContain(id)
})

test("hiding a conversation keeps it in the engine", async () => {
  const id = await create()
  await hideSession(id)
  expect(((await (await client()).session.list()) ?? []).some((info) => info.id === id)).toBe(true)
})
