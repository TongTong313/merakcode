/**
 * SDK contract: after the agent edits files, the client reviews them hunk by hunk through the review API. Accepted
 * hunks are no longer listed, rejected hunks are reverted on disk, decisions on a stale list fail with 409, and
 * review changes publish a review.updated event.
 */
import { afterAll, beforeAll, expect, test } from "vitest"
import path from "node:path"
import { Filesystem } from "@merakcode/util/filesystem"
import { createMerakCode, type MerakCode } from "@merakcode/sdk"
import { engine, sandbox, type Sandbox } from "../fixture/engine"
import { fakeModel, type Reply, type Turn } from "../fixture/model"

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join("")
const changed = lines(30).replace("line 2\n", "two\n").replace("line 20\n", "twenty\n")

let script: (turn: Turn) => Reply = () => ({ text: "OK" })
let model: Awaited<ReturnType<typeof fakeModel>>
let env: Sandbox
let merak: MerakCode

beforeAll(async () => {
  model = await fakeModel((turn) => script(turn))
  env = await sandbox(model.url)
  merak = await createMerakCode({ cwd: env.project, executablePath: engine, env: env.env })
}, 120_000)

afterAll(async () => {
  await merak?.close()
  await model?.close()
  await env?.[Symbol.asyncDispose]()
})

test("hunks of agent edits can be accepted and rejected, stale hunks get 409, changes emit review.updated", async () => {
  const a = path.join(env.project, "a.txt")
  const b = path.join(env.project, "b.txt")
  await Filesystem.write(a, lines(30))
  const steps: Reply[] = [
    { tool: "read", args: { filePath: a } },
    { tool: "write", args: { filePath: a, content: changed } },
    { tool: "write", args: { filePath: b, content: "new\n" } },
    { text: "改好了" },
  ]
  script = (turn) => steps[turn.results.length]!
  const session = await merak.session()
  for await (const _ of session.run("改两个文件", { mode: "auto" })) void _

  const { client } = merak
  const input = { scope: "session" as const, sessionID: session.id }
  const review = (await client.review.get(input, { throwOnError: true })).data
  expect(review.files.map((file) => [file.file, file.status, file.hunks.length])).toEqual([
    ["a.txt", "modified", 2],
    ["b.txt", "added", 1],
  ])
  const [first, second] = review.files[0]!.hunks

  const abort = new AbortController()
  const events = await client.event.subscribe(undefined, { signal: abort.signal })
  const updated = (async () => {
    for await (const event of events.stream) if (event.type === "review.updated") return event.properties
  })()

  const accepted = await client.review.decide(
    { ...input, decision: "accept", files: [{ file: "a.txt", hunks: [first!.id] }] },
    { throwOnError: true },
  )
  expect(accepted.data.files.find((file) => file.file === "a.txt")!.hunks.map((hunk) => hunk.id)).toEqual([second!.id])
  expect(await updated).toEqual({ scope: "session", sessionID: session.id })
  abort.abort()

  await client.review.decide(
    { ...input, decision: "reject", files: [{ file: "a.txt", hunks: [second!.id] }] },
    { throwOnError: true },
  )
  expect(await Filesystem.readText(a)).toBe(lines(30).replace("line 2\n", "two\n"))

  const stale = await client.review.decide({
    ...input,
    decision: "reject",
    files: [{ file: "a.txt", hunks: [second!.id] }],
  })
  expect(stale.response.status).toBe(409)
  expect(stale.error).toMatchObject({ name: "ReviewStaleError" })
  expect(await Filesystem.exists(b)).toBe(true)

  // Undoing the rejection puts the hunk back into the file, ready for review again
  const undone = await client.review.undo(input, { throwOnError: true })
  expect(await Filesystem.readText(a)).toBe(changed)
  expect(undone.data.files.find((file) => file.file === "a.txt")!.hunks.map((hunk) => hunk.id)).toEqual([second!.id])
}, 120_000)
