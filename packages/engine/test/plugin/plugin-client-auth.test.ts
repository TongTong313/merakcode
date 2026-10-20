import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import { pathToFileURL } from "url"
import { Plugin } from "@merakcode/engine/plugin/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { Session } from "@merakcode/engine/session/index"
import { Identifier } from "@merakcode/util/id"
import { setLocalSecretForTest } from "@merakcode/engine/auth/local-secret"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Config } from "../../src/config/config"

/**
 * The plugin's in-process client must send the local auth header, as opencode 1.16.2 does with
 * `headers: ServerAuth.headers()`. With a password set, the Basic Auth middleware in `server.ts` returns 401 for
 * requests without credentials; the plugin client goes through `Server.App().fetch` in process, but the middleware
 * still runs, and `input.client.session.message()` would silently return undefined.
 *
 * Uses a real plugin file loaded via file:// and real Server.App() routes, without mocking the client.
 */

const SECRET = "p1-3-fixture-password"

afterEach(() => {
  setLocalSecretForTest(undefined)
})

async function writePlugin(dir: string, name: string, body: string) {
  const file = path.join(dir, `${name}.ts`)
  await Filesystem.write(file, body)
  return pathToFileURL(file).href
}

/** Write a user message directly instead of prompting, so plugins don't initialize before the message exists */
async function writeUserMessage(sessionID: string) {
  const info = await Session.updateInfo({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "test-provider", modelID: "test-model" },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: info.id,
    type: "text",
    text: "q",
  })
  return { info }
}

/** On load the plugin reads the message back through input.client and stores the result on globalThis */
const PLUGIN_BODY = `
export default {
  id: "p1-3-client-auth-plugin",
  server: async (input) => {
    const target = globalThis.__p13Target__
    const result = await input.client.session.message({
      sessionID: target.sessionID,
      messageID: target.messageID,
      directory: input.directory,
    })
    globalThis.__p13Result__ = {
      status: result?.response?.status,
      role: result?.data?.info?.role,
      id: result?.data?.info?.id,
    }
    return {}
  },
}
`

describe("local auth for the plugin in-process client", () => {
  test("with a password set, the plugin can still read messages through input.client", async () => {
    await using tmp = await tmpdir({ git: true })
    const pluginUrl = await writePlugin(tmp.path, "client-auth-plugin", PLUGIN_BODY)
    await Filesystem.write(
      path.join(tmp.path, "merakcode.json"),
      JSON.stringify({ $schema: Config.SCHEMA, plugin: [pluginUrl] }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await writeUserMessage(session.id)
        ;(globalThis as Record<string, unknown>).__p13Target__ = {
          sessionID: session.id,
          messageID: user.info.id,
        }
        ;(globalThis as Record<string, unknown>).__p13Result__ = undefined

        setLocalSecretForTest(SECRET)

        // Confirm auth is actually on, or the test would pass trivially
        const headers = { "x-merakcode-directory": encodeURIComponent(tmp.path) }
        const unauthorized = await Server.App().request(
          `http://localhost/session/${session.id}/message/${user.info.id}`,
          { headers },
        )
        expect(unauthorized.status).toBe(401)

        await Plugin.list()

        const result = (globalThis as Record<string, unknown>).__p13Result__ as
          { status?: number; role?: string; id?: string } | undefined
        expect(result?.status).toBe(200)
        expect(result?.role).toBe("user")
        expect(result?.id).toBe(user.info.id)
      },
    })
  })

  test("without a password the client still works and no authorization header is invented", async () => {
    await using tmp = await tmpdir({ git: true })
    const pluginUrl = await writePlugin(tmp.path, "client-noauth-plugin", PLUGIN_BODY)
    await Filesystem.write(
      path.join(tmp.path, "merakcode.json"),
      JSON.stringify({ $schema: Config.SCHEMA, plugin: [pluginUrl] }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await writeUserMessage(session.id)
        ;(globalThis as Record<string, unknown>).__p13Target__ = {
          sessionID: session.id,
          messageID: user.info.id,
        }
        ;(globalThis as Record<string, unknown>).__p13Result__ = undefined

        await Plugin.list()

        const result = (globalThis as Record<string, unknown>).__p13Result__ as { status?: number } | undefined
        expect(result?.status).toBe(200)
      },
    })
  })
})
