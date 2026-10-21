/**
 * Streamed text is only written on completion, so when the user stops mid-stream the partial reply must still reach
 * the transcript instead of being lost with the unwritten deltas.
 */
import { afterEach, expect, test } from "vitest"
import type { Provider } from "@merakcode/engine/provider/provider"
import { Agent } from "@merakcode/engine/agent/agent"
import { Session } from "@merakcode/engine/session/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/session/message"
import { LLM } from "@merakcode/engine/session/llm"
import { Database } from "@merakcode/engine/storage/db"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const stream = LLM.stream

afterEach(() => {
  LLM.stream = stream
})

test("stopping mid-stream writes the partial text to the transcript when the message finalizes", async () => {
  const controller = new AbortController()
  LLM.stream = async () =>
    ({
      stream: (async function* () {
        yield { type: "start-step" }
        yield { type: "text-start", id: "t1" }
        yield { type: "text-delta", id: "t1", text: "已经生成的" }
        yield { type: "text-delta", id: "t1", text: "半段回复" }
        controller.abort()
        yield { type: "text-delta", id: "t1", text: "停止之后的内容" }
      })(),
    }) as unknown as Awaited<ReturnType<typeof LLM.stream>>

  const { SessionProcessor } = await import("@merakcode/engine/session/processor")
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })
      const assistantInfo: Message.AssistantInfo = {
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID: session.id,
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "gpt-4",
        providerID: "openai",
        parentID: user.id,
        time: { created: Date.now() },
      }
      await Session.updateInfo(assistantInfo)
      const model = {
        id: "gpt-4",
        providerID: "openai",
        modelID: "gpt-4",
        api: { id: "gpt-4" },
      } as unknown as Provider.Model

      const proc = SessionProcessor.create({ assistantInfo, sessionID: session.id, model, abort: controller.signal })
      await proc.process({
        user: user as Message.UserInfo,
        agent: (await Agent.get("build"))!,
        abort: controller.signal,
        sessionID: session.id,
        system: [],
        messages: [],
        tools: {},
        model,
      })

      // Read the stored rows, bypassing the in-process copy, to prove the text was actually written.
      const rows = (sql: string) =>
        (Database.query(sql).all(session.id, assistantInfo.id) as { data: string }[]).map((row) => JSON.parse(row.data))
      const texts = rows("SELECT data FROM part WHERE session_id = ? AND message_id = ?")
        .filter((part) => part.type === "text")
        .map((part) => part.text)
      expect(texts).toEqual(["已经生成的半段回复"])

      const [stored] = rows("SELECT data FROM message WHERE session_id = ? AND id = ?")
      expect(stored.time.completed).toBeTypeOf("number")
      expect(stored.error?.name).toBe("MessageAbortedError")
    },
  })
})
