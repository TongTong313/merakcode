import { describe, expect, test } from "vitest"
import { Bus } from "@merakcode/engine/bus/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { Session } from "@merakcode/engine/session/index"
import { Message } from "@merakcode/engine/session/message"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

/**
 * SDK compatibility surface: directory header, Session.metadata and session.deleteMessage. Everything goes through
 * real Server.App() routes; no model is involved (noReply only writes user messages).
 */

const model = { providerID: "test-provider", modelID: "test-model" }

/**
 * Send the current Instance directory header; without it the server opens another Instance for process.cwd() and
 * sessions and the event bus no longer match
 */
function json(app: ReturnType<typeof Server.App>, method: string, url: string, body?: unknown) {
  return app.request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-merakcode-directory": encodeURIComponent(Instance.directory),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** The directory comes from `?directory=`, then the `x-merakcode-directory` header, then `process.cwd()` */
describe("directory request header", () => {
  test("the product header works and the query parameter takes precedence", async () => {
    await using tmp = await tmpdir({ git: true })
    await using other = await tmpdir({ git: true })
    const app = Server.App()

    const viaHeader = await app.request("/path", {
      headers: { "x-merakcode-directory": encodeURIComponent(tmp.path) },
    })
    expect(viaHeader.status).toBe(200)
    expect(((await viaHeader.json()) as { directory: string }).directory).toBe(tmp.path)

    // `?directory=` must win: the SDK rewrites the header into a query parameter for GET/HEAD
    const viaQuery = await app.request(`/path?directory=${encodeURIComponent(tmp.path)}`, {
      headers: { "x-merakcode-directory": encodeURIComponent(other.path) },
    })
    expect(((await viaQuery.json()) as { directory: string }).directory).toBe(tmp.path)
  })

  test("x-opencode-directory is not accepted", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()

    const viaOpencode = await app.request("/path", {
      headers: { "x-opencode-directory": encodeURIComponent(tmp.path) },
    })
    // The header is ignored and the directory falls back to process.cwd()
    expect(((await viaOpencode.json()) as { directory: string }).directory).not.toBe(tmp.path)
  })
})

describe("Session.metadata", () => {
  test("create stores it, get returns it and update replaces the whole field", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const created = await json(app, "POST", "/session", { metadata: { purpose: "memory", internal: true } })
        expect(created.status).toBe(200)
        const session = (await created.json()) as Session.Info
        expect(session.metadata).toEqual({ purpose: "memory", internal: true })

        const fetched = (await Session.get(session.id)).metadata
        expect(fetched).toEqual({ purpose: "memory", internal: true })

        // Replaced as a whole, so the old purpose key is gone (same as opencode 1.16.2)
        const updated = await json(app, "PATCH", `/session/${session.id}`, { metadata: { internal: false } })
        expect(updated.status).toBe(200)
        expect(((await updated.json()) as Session.Info).metadata).toEqual({ internal: false })

        // An update without metadata leaves it alone
        const titled = await json(app, "PATCH", `/session/${session.id}`, { title: "t" })
        expect(((await titled.json()) as Session.Info).metadata).toEqual({ internal: false })
      },
    })
  })
})

describe("session.deleteMessage", () => {
  test("deletes the message and all its parts, emits message.removed and returns true", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})
        const prompt = (text: string) =>
          SessionRunner.prompt({
            sessionID: session.id,
            agent: "build",
            model,
            noReply: true,
            parts: [{ type: "text", text }],
          })
        const kept = await prompt("q")
        const target = await prompt("q2")

        const removed: string[] = []
        const unsub = Bus.subscribe(Message.Event.Removed, (e) => {
          removed.push(e.properties.messageID)
        })

        const res = await json(app, "DELETE", `/session/${session.id}/message/${target.info.id}`)
        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)
        unsub()

        expect(removed).toEqual([target.info.id])
        expect(await Message.parts({ sessionID: session.id, messageID: target.info.id })).toEqual([])
        const remaining = await Session.messages({ sessionID: session.id })
        expect(remaining.map((m) => m.info.id)).toEqual([kept.info.id])
        expect(remaining[0].parts.map((p) => p.type)).toEqual(["text"])
      },
    })
  })

  test("returns 404 for a missing message instead of reporting success", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})
        const res = await json(app, "DELETE", `/session/${session.id}/message/msg_00000000000000000000000000`)
        expect(res.status).toBe(404)
      },
    })
  })
})
