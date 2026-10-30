import { afterEach, beforeEach, describe, expect, test } from "vitest"
import path from "path"
import { unlink } from "fs/promises"
import { Global } from "@merakcode/engine/infra/global/index"
import { Server } from "@merakcode/engine/app/server/server"
import { Config } from "@merakcode/engine/app/config/files/config"
import { Provider } from "@merakcode/engine/agent/model/provider"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

const globalConfigCandidates = ["merakcode.jsonc", "merakcode.json"].map((file) => path.join(Global.Path.config, file))

let originalContents: Array<string | undefined> = []

beforeEach(async () => {
  originalContents = await Promise.all(
    globalConfigCandidates.map((filepath) => Filesystem.readText(filepath).catch(() => undefined)),
  )
})

afterEach(async () => {
  await Promise.all(
    globalConfigCandidates.map(async (filepath, index) => {
      const original = originalContents[index]
      if (original === undefined) {
        await unlink(filepath).catch(() => undefined)
      } else {
        await Filesystem.write(filepath, original)
      }
    }),
  )
  Config.global.reset()
  Config.state.invalidateAll()
  Provider.invalidateAll()
})

async function writeGlobalProviderConfig() {
  await Promise.all(globalConfigCandidates.map((candidate) => unlink(candidate).catch(() => undefined)))
  const filepath = path.join(Global.Path.config, "merakcode.json")
  await Filesystem.write(
    filepath,
    JSON.stringify({
      $schema: Config.SCHEMA,
      provider: {
        myllm: {
          npm: "@ai-sdk/openai-compatible",
          name: "My LLM",
          options: { apiKey: "test-key", baseURL: "https://api.example.com/v1" },
          models: {
            m1: { name: "M1" },
            m2: { name: "M2" },
          },
        },
      },
    }),
  )
  Config.global.reset()
  Config.state.invalidateAll()
  Provider.invalidateAll()
}

describe("global provider config sync", () => {
  test("provider.list drops a model after DELETE model", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "merakcode.json"), JSON.stringify({ $schema: Config.SCHEMA }))
      },
    })
    await writeGlobalProviderConfig()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const before = await Provider.list()
        expect(before["myllm"]?.models?.["m1"]).toBeDefined()
        expect(before["myllm"]?.models?.["m2"]).toBeDefined()

        const response = await Server.App().request("http://localhost/global/config/provider/myllm/model/m1", {
          method: "DELETE",
        })
        expect(response.status).toBe(200)

        const after = await Provider.list()
        expect(after["myllm"]?.models?.["m1"]).toBeUndefined()
        expect(after["myllm"]?.models?.["m2"]).toBeDefined()
      },
    })
  })

  test("provider.list drops a provider after DELETE provider", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "merakcode.json"), JSON.stringify({ $schema: Config.SCHEMA }))
      },
    })
    await writeGlobalProviderConfig()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await Provider.list())["myllm"]).toBeDefined()

        const response = await Server.App().request("http://localhost/global/config/provider/myllm", {
          method: "DELETE",
        })
        expect(response.status).toBe(200)

        expect((await Provider.list())["myllm"]).toBeUndefined()
      },
    })
  })
})
