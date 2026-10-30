import { SessionOperations } from "@merakcode/engine/app/session"
import { describe, expect, test } from "vitest"
import path from "path"
import { Session } from "@merakcode/engine/agent/session/index"
import { Message } from "@merakcode/engine/agent/session/message"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Server } from "@merakcode/engine/app/server/server"
import { Log } from "@merakcode/log/logger"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

/** Build a minimal session in the export-full format to feed the import-full route */
function buildExportPayload(overrides?: { sessionID?: string; parentID?: string }) {
  const sessionID = overrides?.sessionID ?? "ses_00000000000000000000000000"
  const userMessageID = "msg_user0000000000000000000"
  const assistantMessageID = "msg_asst0000000000000000000"

  const info: Session.Info = {
    id: sessionID,
    slug: "test-import-full",
    projectID: "does-not-matter",
    directory: "/does/not/matter",
    parentID: overrides?.parentID,
    title: "导入导出测试会话",
    version: "1.2.3",
    time: { created: Date.now(), updated: Date.now() },
  }

  const messages: Message.FullMsg[] = [
    {
      info: {
        id: userMessageID,
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      },
      parts: [
        {
          id: "prt_user000000000000000000",
          sessionID,
          messageID: userMessageID,
          type: "text",
          text: "你好",
        },
      ],
    },
    {
      info: {
        id: assistantMessageID,
        sessionID,
        role: "assistant",
        time: { created: Date.now() },
        parentID: userMessageID,
        modelID: "claude-sonnet-5",
        providerID: "anthropic",
        mode: "build",
        agent: "build",
        path: { cwd: "/does/not/matter", root: "/does/not/matter" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: "prt_asst000000000000000000",
          sessionID,
          messageID: assistantMessageID,
          type: "text",
          text: "你好，有什么可以帮你？",
        },
      ],
    },
  ]

  return { info, messages }
}

async function postImportFull(app: ReturnType<typeof Server.App>, payload: ReturnType<typeof buildExportPayload>) {
  const res = await app.request("/session/import-full", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  return { res, body: (await res.json()) as { info: Session.Info } }
}

describe("session.importFull", () => {
  test("rebuilds imported command provenance from all model-visible text", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const payload = buildExportPayload()
        const user = payload.messages[0]!
        if (user.info.role !== "user" || Message.isExternal(user.info)) throw new Error("expected user message")
        const original = user.parts[0]!
        if (original.type !== "text") throw new Error("expected text part")
        user.info.commandSource = { templatePartIDs: ["missing"] }
        user.parts = [
          { ...original, text: "模板正文" },
          { ...original, id: "prt_extra", text: "遗漏的敏感正文", synthetic: true },
          { ...original, id: "prt_ignored", text: "已忽略", ignored: true },
        ]

        const { res, body } = await postImportFull(app, payload)
        expect(res.status).toBe(200)
        const imported = (await Session.messages({ sessionID: body.info.id }))[0]!
        if (imported.info.role !== "user" || Message.isExternal(imported.info)) throw new Error("expected user message")
        expect(imported.parts.map((part) => part.id)).not.toContain(original.id)
        expect(imported.info.commandSource).toEqual({ templatePartIDs: [imported.parts[0]!.id, imported.parts[1]!.id] })
        expect(Message.userSourceTexts(imported)).toEqual(["模板正文\n遗漏的敏感正文"])
        const patchPart = (partID: string, part: unknown) =>
          app.request(`/session/${body.info.id}/message/${imported.info.id}/part/${partID}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(part),
          })
        const addedID = "prt_public_added"
        const added = await patchPart(addedID, {
          ...imported.parts[1],
          id: addedID,
          text: "新增但不在来源 ID 中的模型正文",
        })
        expect(added.status).toBe(400)
        expect((await added.json()).error).toContain("cannot be added")
        const changedType = await patchPart(imported.parts[1]!.id, {
          ...imported.parts[1],
          type: "reasoning",
          text: "改变已有 part 类型",
          time: { start: 1 },
        })
        expect(changedType.status).toBe(400)
        expect((await changedType.json()).error).toContain("change type")
        const uncovered = await patchPart(imported.parts[2]!.id, {
          ...imported.parts[2],
          ignored: false,
        })
        expect(uncovered.status).toBe(400)
        expect((await uncovered.json()).error).toContain("source IDs")
        const afterRejected = (await Session.messages({ sessionID: body.info.id }))[0]!
        expect(afterRejected.parts.map((part) => part.id)).not.toContain(addedID)
        expect(Message.userSourceTexts(afterRejected)).toEqual(Message.userSourceTexts(imported))
        const forked = await Session.fork({ sessionID: body.info.id })
        const cloned = (await Session.messages({ sessionID: forked.id }))[0]!
        if (cloned.info.role !== "user" || Message.isExternal(cloned.info)) throw new Error("expected user message")
        expect(cloned.info.commandSource).toEqual({ templatePartIDs: [cloned.parts[0]!.id, cloned.parts[1]!.id] })
        expect(Message.userSourceTexts(cloned)).toEqual(Message.userSourceTexts(imported))
        await SessionOperations.remove(forked.id)
        await SessionOperations.remove(body.info.id)
      },
    })
  })

  test("imported plain user text cannot hide from guards with a synthetic flag", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const payload = buildExportPayload()
        const part = payload.messages[0]!.parts[0]!
        if (part.type !== "text") throw new Error("expected text part")
        part.synthetic = true
        const { res, body } = await postImportFull(Server.App(), payload)
        expect(res.status).toBe(200)
        const imported = (await Session.messages({ sessionID: body.info.id }))[0]!
        expect(Message.userSourceTexts(imported)).toEqual(["你好"])
        const patch = await Server.App().request(
          `/session/${body.info.id}/message/${imported.info.id}/part/${imported.parts[0]!.id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...imported.parts[0], text: "更新后的正文", synthetic: true }),
          },
        )
        expect(patch.status).toBe(200)
        const updated = (await Session.messages({ sessionID: body.info.id }))[0]!
        expect(Message.userSourceTexts(updated)).toEqual(["更新后的正文"])
        expect(updated.parts[0]).not.toHaveProperty("synthetic", true)
        await SessionOperations.remove(body.info.id)
      },
    })
  })

  test("generates a brand-new session ID instead of reusing the exported one", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const payload = buildExportPayload()

        const { res, body } = await postImportFull(app, payload)

        expect(res.status).toBe(200)
        expect(body.info.id).not.toBe(payload.info.id)
        expect(body.info.id.startsWith("ses_")).toBe(true)

        await SessionOperations.remove(body.info.id)
      },
    })
  })

  test("importing the same export twice creates two independent sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const payload = buildExportPayload()

        const { body: import1 } = await postImportFull(app, payload)
        const { body: import2 } = await postImportFull(app, payload)

        expect(import1.info.id).not.toBe(import2.info.id)

        const messages1 = await Session.messages({ sessionID: import1.info.id })
        const messages2 = await Session.messages({ sessionID: import2.info.id })

        expect(messages1).toHaveLength(2)
        expect(messages2).toHaveLength(2)

        // Parts are stored per messageID, so neither import may overwrite the other's text
        const assistant1 = messages1.find((m) => m.info.role === "assistant")!
        const assistant2 = messages2.find((m) => m.info.role === "assistant")!
        const text1 = assistant1.parts.find((p) => p.type === "text")
        const text2 = assistant2.parts.find((p) => p.type === "text")
        expect(text1?.type === "text" ? text1.text : undefined).toBe("你好，有什么可以帮你？")
        expect(text2?.type === "text" ? text2.text : undefined).toBe("你好，有什么可以帮你？")

        await SessionOperations.remove(import1.info.id)
        await SessionOperations.remove(import2.info.id)
      },
    })
  })

  test("does not merge into or affect an existing session sharing the exported session ID", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        // An existing empty session, as if the chat continued after export
        const existing = await Session.create({})

        // An export that carries the same session id
        const payload = buildExportPayload({ sessionID: existing.id })

        const { res, body } = await postImportFull(app, payload)
        expect(res.status).toBe(200)

        expect(body.info.id).not.toBe(existing.id)

        // The existing session gained no messages
        const existingMessages = await Session.messages({ sessionID: existing.id })
        expect(existingMessages).toHaveLength(0)

        const importedMessages = await Session.messages({ sessionID: body.info.id })
        expect(importedMessages).toHaveLength(2)

        await SessionOperations.remove(existing.id)
        await SessionOperations.remove(body.info.id)
      },
    })
  })

  test("remaps assistant parentID to the new user message id", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const payload = buildExportPayload()

        const { body } = await postImportFull(app, payload)

        const messages = await Session.messages({ sessionID: body.info.id })
        const user = messages.find((m) => m.info.role === "user")!
        const assistant = messages.find((m) => m.info.role === "assistant")!

        expect(user.info.id).not.toBe(payload.messages[0]!.info.id)
        expect(assistant.info.role === "assistant" ? assistant.info.parentID : undefined).toBe(user.info.id)

        await SessionOperations.remove(body.info.id)
      },
    })
  })

  test("clears parentID so the imported session is never treated as a child session", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const payload = buildExportPayload({ parentID: "ses_fakefakefakefakefakefake0" })

        const { body } = await postImportFull(app, payload)

        expect(body.info.parentID).toBeUndefined()

        await SessionOperations.remove(body.info.id)
      },
    })
  })

  test("round-trips Message.metadata written by a plugin on the original export", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const payload = buildExportPayload()
        payload.messages[0]!.info.metadata = { tenant: "acme" }
        payload.messages[1]!.info.metadata = { tenant: "acme", reviewed: true }

        const { res, body } = await postImportFull(app, payload)
        expect(res.status).toBe(200)

        const messages = await Session.messages({ sessionID: body.info.id })
        const user = messages.find((m) => m.info.role === "user")!
        const assistant = messages.find((m) => m.info.role === "assistant")!
        expect(user.info.metadata).toEqual({ tenant: "acme" })
        expect(assistant.info.metadata).toEqual({ tenant: "acme", reviewed: true })

        await SessionOperations.remove(body.info.id)
      },
    })
  })

  test("rejects with 400 and structured field errors when info is missing entirely", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/session/import-full", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [] }),
        })

        expect(res.status).toBe(400)
        const body = (await res.json()) as { code: string; data: { issues: Array<{ path: string[] }> } }
        expect(body.code).toBe("MRK-1009")
        expect(body.data.issues.some((issue) => issue.path[0] === "info")).toBe(true)
      },
    })
  })

  test("rejects with 400 and structured field errors when info is an empty object", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/session/import-full", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ info: {}, messages: [] }),
        })

        expect(res.status).toBe(400)
        const body = (await res.json()) as { code: string; data: { issues: Array<{ path: string[] }> } }
        expect(body.code).toBe("MRK-1009")
        expect(body.data.issues.some((issue) => issue.path[0] === "info" && issue.path[1] === "id")).toBe(true)
      },
    })
  })
})
