/**
 * An ACP session without a model uses the engine's own default: the first connected provider in the engine's order,
 * then that provider's default model.
 */
import { afterAll, beforeAll, expect, test } from "vitest"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { startEngine, type Engine } from "@merakcode/sdk/process"
import { createMerakCodeClient } from "@merakcode/sdk/client"
import { ACP } from "../../src/cli/acp/agent"
import { cli, tmpdir } from "../fixture/fixture"

let engine: Engine
let project: Awaited<ReturnType<typeof tmpdir>>

beforeAll(async () => {
  project = await tmpdir({ git: true })
  engine = await startEngine({
    cwd: project.path,
    executablePath: cli,
    env: { MERAKCODE_DISABLE_CATALOG_FETCH: "1" },
    config: { provider: { "alibaba-cn": { options: { apiKey: "sk-test" } } } },
  })
}, 120_000)

afterAll(async () => {
  await engine?.close()
  await project?.[Symbol.asyncDispose]()
})

test("without a model, uses the default model of the first connected provider, like the engine", async () => {
  const sdk = createMerakCodeClient({ baseUrl: engine.url, headers: engine.headers, directory: project.path })
  const expected = await sdk.provider.list(undefined, { throwOnError: true }).then((x) => {
    const provider = x.data.connected[0]!
    return `${provider}/${x.data.default[provider]}`
  })
  expect(expected).toBe("alibaba-cn/qwen-plus")

  const connection = {
    sessionUpdate: async () => {},
    requestPermission: async () => ({}),
  } as unknown as AgentSideConnection
  const agent = new ACP.Agent(connection, { sdk })
  const session = await agent.newSession({ cwd: project.path, mcpServers: [] })
  const model = session.configOptions?.find((option) => option.id === "model")
  expect(model?.currentValue).toBe(expected)
}, 120_000)
