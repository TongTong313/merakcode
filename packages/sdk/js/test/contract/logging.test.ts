/**
 * SDK logging: the optional logger callback, and the client run id that ties engine log lines to the caller.
 */
import { afterAll, beforeAll, expect, test } from "vitest"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { createMerakCode, type LogEntry } from "@merakcode/sdk"
import { engine, sandbox, type Sandbox } from "../fixture/engine"
import { fakeModel } from "../fixture/model"

let model: Awaited<ReturnType<typeof fakeModel>>
let env: Sandbox

beforeAll(async () => {
  model = await fakeModel(() => ({ text: "OK" }))
  env = await sandbox(model.url)
})

afterAll(async () => {
  await model?.close()
  await env?.[Symbol.asyncDispose]()
})

async function lines(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson"))
  const texts = await Promise.all(files.map((entry) => readFile(path.join(entry.parentPath, entry.name), "utf8")))
  return texts.flatMap((text) => text.split("\n").filter(Boolean))
}

test("the logger hears the engine start and exit; failed requests too", async () => {
  const entries: LogEntry[] = []
  const merak = await createMerakCode({
    cwd: env.project,
    executablePath: engine,
    env: env.env,
    logger: (entry) => entries.push(entry),
  })
  await merak.session({ id: "ses_missing" }).catch(() => undefined)
  await merak.close()
  const messages = entries.map((entry) => entry.message)
  expect(messages).toContain("engine starting")
  expect(messages).toContain("engine listening")
  expect(messages).toContain("engine exited")
  expect(entries.find((entry) => entry.message === "engine listening")!.data).toMatchObject({ pid: expect.any(Number) })
  expect(entries.find((entry) => entry.message === "request failed")!.data).toMatchObject({
    status: 404,
    code: "MRK-1011",
  })
}, 120_000)

test("the engine log records the client run id of every request", async () => {
  const merak = await createMerakCode({
    cwd: env.project,
    executablePath: engine,
    env: env.env,
    clientRun: "client-run-test",
  })
  await merak.session()
  await merak.close()
  const records = (await lines(env.env.MERAKCODE_LOG_ROOT!)).flatMap((line) => {
    try {
      return [JSON.parse(line) as { message: string; attributes?: { clientRun?: string } }]
    } catch {
      return []
    }
  })
  expect(
    records.some(
      (record) => record.message === "request completed" && record.attributes?.clientRun === "client-run-test",
    ),
  ).toBe(true)
}, 120_000)
