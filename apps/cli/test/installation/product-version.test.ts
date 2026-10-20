// Running from source, the engine started by `merak serve` reports the product version from apps/cli/package.json
import { expect, test } from "vitest"
import { startEngine } from "@merakcode/sdk/process"
import { createMerakCodeClient } from "@merakcode/sdk/client"
import { cli, tmpdir } from "../fixture/fixture"
import pkg from "../../package.json"

test("the engine started from source reports the CLI's product version", async () => {
  await using tmp = await tmpdir()
  const engine = await startEngine({ cwd: tmp.path, executablePath: cli })
  try {
    const client = createMerakCodeClient({ baseUrl: engine.url, headers: engine.headers, directory: tmp.path })
    const health = await client.global.health()
    expect(health.data?.version).toBe(pkg.version)
  } finally {
    await engine.close()
  }
}, 60_000)
