/**
 * SDK contract: the typed methods for full session export and import and for workflow runs.
 * Exporting and importing gives a new session with the same messages, a malformed import fails with 400 and names
 * the field under data.issues, and workflow runs are listed and cancelled per session.
 */
import { afterAll, beforeAll, expect, test } from "vitest"
import { createMerakCode, type MerakCode } from "@merakcode/sdk"
import { engine, sandbox, type Sandbox } from "../fixture/engine"
import { fakeModel } from "../fixture/model"

type ImportFull = Parameters<MerakCode["client"]["session"]["importFull"]>[0]

let model: Awaited<ReturnType<typeof fakeModel>>
let env: Sandbox
let merak: MerakCode

beforeAll(async () => {
  model = await fakeModel(() => ({ text: "OK" }))
  env = await sandbox(model.url)
  merak = await createMerakCode({ cwd: env.project, executablePath: engine, env: env.env })
}, 120_000)

afterAll(async () => {
  await merak?.close()
  await model?.close()
  await env?.[Symbol.asyncDispose]()
})

test("a fully exported session imports as a new session with the same messages", async () => {
  const session = await merak.session()
  for await (const _ of session.run("hello")) void _
  const { client } = merak
  const exported = (await client.session.exportFull({ sessionID: session.id }, { throwOnError: true })).data
  expect(exported.info.id).toBe(session.id)

  const { info, messages } = exported as ImportFull
  const imported = (await client.session.importFull({ info, messages }, { throwOnError: true })).data
  expect(imported.info.id).not.toBe(session.id)
  const restored = (await client.session.messages({ sessionID: imported.info.id }, { throwOnError: true })).data
  expect(restored.map((message) => message.info.role)).toEqual(exported.messages.map((message) => message.info.role))
}, 120_000)

test("a malformed import fails with 400 and names the missing field under data.issues", async () => {
  const result = await merak.client.session.importFull({ messages: [] } as unknown as ImportFull)
  expect(result.response.status).toBe(400)
  const details = result.error?.data as { issues?: Array<{ path: string[] }> } | undefined
  expect(details?.issues?.some((issue) => issue.path[0] === "info")).toBe(true)
})

test("workflow runs are listed per session, and cancelling an unknown run reports false", async () => {
  const session = await merak.session()
  const { client } = merak
  expect((await client.workflow.list({ sessionID: session.id }, { throwOnError: true })).data).toEqual([])
  const cancelled = await client.workflow.cancel({ sessionID: session.id, runId: "missing" }, { throwOnError: true })
  expect(cancelled.data).toBe(false)
})
