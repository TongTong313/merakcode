import fs from "node:fs/promises"
import { adapter } from "@merakcode/sdk/adapter"

adapter({
  inspect: () => ({ name: "Streaming fixture" }),
  async run(task, host) {
    if (process.argv[2] === "malformed") return JSON.parse('{"text":42}')
    if (process.argv[2] === "malformed-text") {
      host.textDelta(JSON.parse('{"messageID":"reply","partID":"text","delta":42}'))
      return { text: "Invalid text must not complete" }
    }
    if (process.argv[2] === "malformed-step") {
      host.step(JSON.parse('{"tool":42}'))
      return { text: "Invalid step must not complete" }
    }
    if (process.argv[2] === "ack") {
      let acknowledged = false
      const started = host.sessionStarted({ sessionId: "thread-fixture" }).then(() => {
        acknowledged = true
      })
      started.catch(() => undefined)
      await host.permission({ kind: "tool", name: "ack-checkpoint" })
      await host.permission({ kind: "tool", name: acknowledged ? "ack-complete" : "ack-pending" })
      await started
      await host.permission({ kind: "tool", name: "after-ack" })
      host.textDelta({ messageID: "reply", partID: "text", delta: "Hello " })
      host.textDelta({ messageID: "reply", partID: "text", delta: "world" })
      return { text: "Hello world", sessionId: "thread-fixture" }
    }
    await host.sessionStarted({ sessionId: "thread-fixture" })
    host.textDelta({ messageID: "reply", partID: "text", delta: "Hello " })
    for (;;) {
      if (task.signal.aborted) throw new Error("Stopped")
      if (
        await fs.access(task.prompt).then(
          () => true,
          () => false,
        )
      )
        break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    host.textDelta({ messageID: "reply", partID: "text", delta: "world" })
    return { text: "Hello world", sessionId: "thread-fixture" }
  },
})
