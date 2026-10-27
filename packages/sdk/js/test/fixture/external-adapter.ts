import { adapter } from "@merakcode/sdk/adapter"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"

adapter({
  inspect: () => ({
    name: "SDK fixture",
    capabilities: {
      modelSelection: true,
      modelDiscovery: false,
      textStreaming: true,
      resume: true,
      permission: "merak",
      questions: true,
    },
  }),
  async run(task, host) {
    const sessionId = task.resume ?? `sdk-fixture-thread-${randomUUID()}`
    await host.sessionStarted({ sessionId })
    if (task.prompt.startsWith("step-without-text:")) {
      host.step({ tool: "Write", detail: "ALREADY_EDITED_MARKER.txt" })
      if (task.prompt.endsWith("failed")) throw new Error("Stopped after the observed step")
      while (!task.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 10))
      task.signal.throwIfAborted()
    }
    if (task.prompt === "report external thread") {
      const text = `Thread: ${sessionId}`
      host.textDelta({ messageID: "reply", partID: "text", delta: text })
      return {
        text,
        sessionId,
        actualModel: { id: task.model?.id === "fixture-second" ? "fixture-selected-second" : "fixture-selected" },
        final: { messageID: "reply", parts: [{ partID: "text", text }] },
      }
    }
    if (task.prompt.startsWith("gate:")) {
      host.textDelta({ messageID: "reply", partID: "text", delta: "Hello " })
      while (
        !(await fs.access(task.prompt.slice(5)).then(
          () => true,
          () => false,
        ))
      ) {
        task.signal.throwIfAborted()
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      host.textDelta({ messageID: "reply", partID: "text", delta: "world" })
      return {
        text: "Hello world",
        sessionId,
        final: { messageID: "reply", parts: [{ partID: "text", text: "Hello world" }] },
      }
    }
    const text = `External reply: ${task.prompt}`
    host.textDelta({ messageID: "reply", partID: "text", delta: "External reply: " })
    host.textDelta({ messageID: "reply", partID: "text", delta: task.prompt })
    return {
      text,
      sessionId,
      actualModel: { id: "fixture-selected" },
      final: { messageID: "reply", parts: [{ partID: "text", text }] },
    }
  },
})
