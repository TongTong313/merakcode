import { afterEach, beforeEach, expect, test } from "vitest"
import path from "path"
import { Auth } from "@merakcode/engine/auth/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Provider } from "@merakcode/engine/provider/provider"
import { Session } from "@merakcode/engine/session/index"
import { Message } from "@merakcode/engine/session/message"
import { LLM } from "@merakcode/engine/session/llm"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { SessionUndoRedo } from "@merakcode/engine/session/undo-redo"
import { Snapshot } from "@merakcode/engine/snapshot/index"
import { Filesystem } from "@merakcode/util/filesystem"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

// When the model calls a tool right away, the AI SDK runs it before the engine handles the step start. The step's
// backup must exist before the model is called, or the tool's changes land in the previous step (or nowhere) and
// undo can't restore them.

Log.init({ print: false })

const originalStream = LLM.stream
const originalGetModel = Provider.getModel
const originalGetProvider = Provider.getProvider
const originalGetAuth = Auth.get

beforeEach(() => {
  Provider.getModel = (async () => ({
    id: "test-model",
    providerID: "test-provider",
    modelID: "test-model",
    api: { id: "test-model", npm: "@ai-sdk/openai-compatible" },
    limit: { context: 128000, output: 8192 },
  })) as unknown as typeof Provider.getModel
  Provider.getProvider = (async () => ({ id: "test-provider", options: {} })) as unknown as typeof Provider.getProvider
  Auth.get = (async () => undefined) as unknown as typeof Auth.get
})

afterEach(() => {
  LLM.stream = originalStream
  Provider.getModel = originalGetModel
  Provider.getProvider = originalGetProvider
  Auth.get = originalGetAuth
})

test("file changed by a tool before the step starts is recorded in that step and undo restores it", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "made.txt")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      let calls = 0
      // Count only main agent calls; title generation and the like also go through LLM.stream.
      LLM.stream = (async (input: { agent?: { id?: string } }) => {
        if (input.agent?.id === "build") calls += 1
        const first = input.agent?.id === "build" && calls === 1
        return {
          stream: (async function* () {
            // As in the AI SDK, the tool runs (backing up before writing) before the consumer handles start-step.
            if (first) {
              await Snapshot.trackFile(file, session.id)
              await Filesystem.write(file, "made\n")
            }
            yield { type: "start" }
            yield { type: "start-step" }
            yield { type: "text-start", id: "t" }
            yield { type: "text-delta", id: "t", text: "写好了" }
            yield { type: "text-end", id: "t" }
            yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
            yield { type: "finish" }
          })(),
        }
      }) as unknown as typeof LLM.stream

      await SessionRunner.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test-provider", modelID: "test-model" },
        parts: [{ type: "text", text: "写文件" }],
      })
      const messages = await Message.filterCompacted(Message.stream(session.id))
      const patches = messages.flatMap((message) => message.parts.filter((part) => part.type === "patch"))
      expect(patches).toHaveLength(1)
      expect(patches[0]).toMatchObject({ files: [file] })

      // Undo back to before the user message.
      await SessionUndoRedo.undo({ sessionID: session.id, messageID: messages[0]!.info.id, revertFiles: true })
      expect(await Filesystem.exists(file)).toBe(false)
    },
  })
})
