/**
 * The examples in examples/ run as they are, as separate processes, against a local fake model. The only change is
 * that `@merakcode/sdk` starts the engine from source (see fixture/example-hooks.mjs).
 */
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import { sandbox, type Sandbox } from "./fixture/engine"
import { fakeModel, type Reply, type Turn } from "./fixture/model"

const root = path.resolve(import.meta.dirname, "..")
const repo = path.resolve(root, "../../..")

let script: (turn: Turn) => Reply = () => ({ text: "OK" })
let model: Awaited<ReturnType<typeof fakeModel>>
let env: Sandbox

beforeAll(async () => {
  model = await fakeModel((turn) => script(turn))
  env = await sandbox(model.url)
})

afterAll(async () => {
  await model?.close()
  await env?.[Symbol.asyncDispose]()
})

function run(example: string, ...args: string[]) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(path.join(repo, "script/node/register.mjs")).href,
      "--import",
      pathToFileURL(path.join(root, "test/fixture/example-hooks.mjs")).href,
      "--disable-warning=ExperimentalWarning",
      path.join(root, "examples", example),
      ...args,
    ],
    { cwd: env.project, env: { ...process.env, MERAKCODE_MODEL: undefined, ...env.env } },
  )
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()))
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()))
  return new Promise<{ code: number | null; output: string }>((resolve) =>
    child.once("exit", (code) => resolve({ code, output })),
  )
}

test("minimal.ts prints the streamed reply", async () => {
  script = () => ({ text: "I am MerakCode." })
  const result = await run("minimal.ts")
  expect(result.output).toContain("I am MerakCode.")
  expect(result.code).toBe(0)
}, 120_000)

test("custom-tool.ts lets the model call the tool defined in the example", async () => {
  script = (turn) =>
    turn.results.length === 0 && turn.tools.includes("stock")
      ? { tool: "stock", args: { fruit: "apple" } }
      : { text: `There are ${turn.results[0]} apples.` }
  const result = await run("custom-tool.ts")
  expect(result.output).toContain("There are 12 apples.")
  expect(result.code).toBe(0)
}, 120_000)

test("batch.ts summarizes each file in its own session", async () => {
  await writeFile(path.join(env.project, "a.md"), "# A\n")
  await writeFile(path.join(env.project, "b.md"), "# B\n")
  // The prompt may also carry project context that lists both files, so match the example's own sentence
  script = (turn) => ({ text: `Summary of ${/Read (\S+) and sum it up/.exec(turn.prompt)?.[1] ?? "?"}` })
  const result = await run("batch.ts", "a.md", "b.md")
  expect(result.output).toContain("a.md: Summary of a.md")
  expect(result.output).toContain("b.md: Summary of b.md")
  expect(result.code).toBe(0)
}, 120_000)
