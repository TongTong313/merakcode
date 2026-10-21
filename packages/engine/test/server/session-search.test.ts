import { afterEach, expect, test } from "vitest"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { Session } from "@merakcode/engine/session/index"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

async function say(sessionID: string, text: string, extra: { synthetic?: boolean } = {}) {
  const message = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID,
    type: "text",
    text,
    ...extra,
  })
  return message
}

async function search(directory: string, term: string, path = "/session/search") {
  const response = await Server.App().request(
    `${path}?search=${encodeURIComponent(term)}&directory=${encodeURIComponent(directory)}`,
  )
  expect(response.status).toBe(200)
  return (await response.json()) as {
    session?: { id: string }
    id?: string
    match?: { messageID: string; text: string }
  }[]
}

test("finds sessions by title or by what was said, with the latest matching text as a snippet", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const titled = await Session.create({ title: "修复登录页" })
      const talked = await Session.create({ title: "随便聊聊" })
      await say(talked.id, "先看看 README")
      const latest = await say(
        talked.id,
        `${"前面的铺垫".repeat(10)}登录之后白屏了，${"后面还有很多很多内容".repeat(10)}`,
      )
      const hidden = await Session.create({ title: "只有附带内容" })
      await say(hidden.id, "登录 attached file content", { synthetic: true })

      const results = await search(tmp.path, "登录")
      expect(results.map((item) => item.session!.id).toSorted()).toEqual([titled.id, talked.id].toSorted())
      expect(results.find((item) => item.session!.id === titled.id)!.match).toBeUndefined()
      const match = results.find((item) => item.session!.id === talked.id)!.match!
      expect(match.messageID).toBe(latest.id)
      expect(match.text).toContain("登录之后白屏了")
      expect(match.text.startsWith("…")).toBe(true)
      expect(match.text.endsWith("…")).toBe(true)
    },
  })
})

test("search is literal, case-insensitive, per project, and forgets deleted sessions", async () => {
  await using first = await tmpdir({ git: true })
  await using second = await tmpdir({ git: true })
  const mine = await Instance.provide({
    directory: first.path,
    fn: async () => {
      const session = await Session.create({ title: "plain" })
      await say(session.id, "Coverage went to 100% today")
      const gone = await Session.create({ title: "plain" })
      await say(gone.id, "coverage 100% again")
      await Session.remove(gone.id)
      return session
    },
  })
  const theirs = await Instance.provide({
    directory: second.path,
    fn: async () => {
      const session = await Session.create({ title: "plain" })
      await say(session.id, "coverage 100% elsewhere")
      return session
    },
  })

  await Instance.provide({
    directory: first.path,
    fn: async () => {
      expect((await search(first.path, "COVERAGE")).map((item) => item.session!.id)).toEqual([mine.id])
      expect((await search(first.path, "100%")).map((item) => item.session!.id)).toEqual([mine.id])
      expect(await search(first.path, "10_%")).toEqual([])
    },
  })
  const everywhere = await search(first.path, "100%", "/global/session/search")
  expect(everywhere.map((item) => item.id).toSorted()).toEqual([mine.id, theirs.id].toSorted())
})
