/**
 * SDK contract: after the agent edits files, the client reviews them hunk by hunk through the review API. The list
 * has counts and a version per file and review.file returns a file's hunks. Accepted hunks are no longer listed,
 * rejected hunks are reverted on disk, decisions on a stale list and details of an old version fail with 409, and
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

test("Git changes use explicit methods and old Git review scopes are invalid", async () => {
  const { client } = merak
  await client.file.write({ path: "draft.txt", content: "keep this draft\n" }, { throwOnError: true })
  const listed = (await client.vcs.changes.get(undefined, { throwOnError: true })).data
  const missing = await client.vcs.changes.stage({ expectedCheckout: undefined as never, files: listed.unstaged })
  expect(missing.response.status).toBe(400)
  for (const scope of ["unstaged", "staged", "branch"]) {
    const invalid = await client.review.get({ scope: scope as never, sessionID: "invalid" })
    expect(invalid.response.status).toBe(400)
  }
  expect((await client.file.read({ path: "draft.txt" }, { throwOnError: true })).data.content).toBe("keep this draft\n")
}, 120_000)

test("Git mutations reject stale checkouts and file versions without changing working files", async () => {
  await using isolated = await sandbox(model.url)
  const connection = await createMerakCode({ cwd: isolated.project, executablePath: engine, env: isolated.env })
  try {
    const { client } = connection
    const run = async (...args: string[]) => {
      expect((await client.vcs.run({ args }, { throwOnError: true })).data.exitCode).toBe(0)
    }
    await run("config", "user.name", "Review Test")
    await run("config", "user.email", "review@example.test")
    await client.file.write({ path: "a.txt", content: "before\n" }, { throwOnError: true })
    await run("add", "a.txt")
    await run("commit", "-m", "initial")
    await client.file.write({ path: "a.txt", content: "after\n" }, { throwOnError: true })
    const old = (await client.vcs.changes.get(undefined, { throwOnError: true })).data
    await run("switch", "-c", "other")
    const stale = await client.vcs.changes.stage({ expectedCheckout: old.checkout, files: old.unstaged })
    expect(stale.response.status).toBe(409)
    expect(stale.error).toMatchObject({ name: "CheckoutStaleError" })
    const fresh = (await client.vcs.changes.get(undefined, { throwOnError: true })).data
    const staged = (
      await client.vcs.changes.stage(
        { expectedCheckout: fresh.checkout, files: fresh.unstaged },
        { throwOnError: true },
      )
    ).data
    expect(staged.staged.map((file) => file.file)).toEqual(["a.txt"])
    const unstaged = (
      await client.vcs.changes.unstage(
        { expectedCheckout: staged.checkout, files: staged.staged },
        { throwOnError: true },
      )
    ).data
    expect(unstaged.staged).toEqual([])
    await client.file.write({ path: "a.txt", content: "later\n" }, { throwOnError: true })
    const changed = await client.vcs.changes.stage({ expectedCheckout: unstaged.checkout, files: unstaged.unstaged })
    expect(changed.response.status).toBe(409)
    expect(changed.error).toMatchObject({ name: "GitChangesStaleError" })
    expect((await client.file.read({ path: "a.txt" }, { throwOnError: true })).data.content).toBe("later\n")
  } finally {
    await connection.close()
  }
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
  const hunksOf = async (file: string) =>
    (await client.review.file({ ...input, file }, { throwOnError: true })).data.hunks
  const review = (await client.review.get(input, { throwOnError: true })).data
  const writeInput = { ...input, expectedCheckout: review.checkout }
  expect(review.files.map((file) => [file.file, file.status, file.hunks])).toEqual([
    ["a.txt", "modified", 2],
    ["b.txt", "added", 1],
  ])
  const listed = review.files[0]!
  const detail = (
    await client.review.file({ ...input, file: "a.txt", version: listed.version }, { throwOnError: true })
  ).data
  expect(detail.version).toBe(listed.version)
  const [first, second] = detail.hunks

  const abort = new AbortController()
  const events = await client.event.subscribe(undefined, { signal: abort.signal })
  const updated = (async () => {
    for await (const event of events.stream) if (event.type === "review.updated") return event.properties
  })()

  const accepted = await client.review.decide(
    { ...writeInput, decision: "accept", files: [{ file: "a.txt", version: listed.version, hunks: [first!.id] }] },
    { throwOnError: true },
  )
  expect(accepted.data.files.find((file) => file.file === "a.txt")!.hunks).toBe(1)
  expect((await hunksOf("a.txt")).map((hunk) => hunk.id)).toEqual([second!.id])
  expect(await updated).toEqual({ scope: "session", sessionID: session.id })
  abort.abort()

  // Accepting moved the base, so the version listed before is stale
  const old = await client.review.file({ ...input, file: "a.txt", version: listed.version })
  expect(old.response.status).toBe(409)
  expect(old.error).toMatchObject({ name: "ReviewStaleError" })

  await client.review.decide(
    {
      ...writeInput,
      decision: "reject",
      files: [
        {
          file: "a.txt",
          version: accepted.data.files.find((file) => file.file === "a.txt")!.version,
          hunks: [second!.id],
        },
      ],
    },
    { throwOnError: true },
  )
  expect(await Filesystem.readText(a)).toBe(lines(30).replace("line 2\n", "two\n"))

  const stale = await client.review.decide({
    ...writeInput,
    decision: "reject",
    files: [
      {
        file: "a.txt",
        version: accepted.data.files.find((file) => file.file === "a.txt")!.version,
        hunks: [second!.id],
      },
    ],
  })
  expect(stale.response.status).toBe(409)
  expect(stale.error).toMatchObject({ name: "ReviewStaleError" })
  expect(await Filesystem.exists(b)).toBe(true)

  // Undoing the rejection puts the hunk back into the file, ready for review again
  const undone = await client.review.undo(writeInput, { throwOnError: true })
  expect(await Filesystem.readText(a)).toBe(changed)
  expect(undone.data.files.find((file) => file.file === "a.txt")!.hunks).toBe(1)
  expect((await hunksOf("a.txt")).map((hunk) => hunk.id)).toEqual([second!.id])
}, 120_000)
