// A member adapter written with the adapter library, as anyone would write one. Its argument is a JSON scenario: the
// steps to report, waiting after one with a gate until that file exists, then the reply.
import fs from "node:fs"
import { adapter } from "@merakcode/sdk/adapter"
import { randomUUID } from "node:crypto"

const scenario = JSON.parse(process.argv[2] ?? "{}") as {
  steps?: { tool: string; detail: string; gate?: string }[]
  reply?: string
  streaming?: { gate?: string; model?: boolean }
}

adapter({
  inspect: () => ({
    name: "Fake member",
    version: "1.0.0",
    capabilities: {
      modelSelection: true,
      modelDiscovery: false,
      textStreaming: !!scenario.streaming,
      resume: true,
      permission: "merak",
      questions: false,
    },
  }),
  async run(task, host) {
    const sessionId = task.resume ?? `e2e-member-${randomUUID()}`
    await host.sessionStarted({ sessionId })
    if (scenario.streaming) {
      host.textDelta({ messageID: "reply", partID: "text", delta: "External reply: " })
      while (scenario.streaming.gate && !fs.existsSync(scenario.streaming.gate)) {
        task.signal.throwIfAborted()
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const body = scenario.streaming.model ? (task.model?.id ?? "fixture-default") : task.prompt
      host.textDelta({ messageID: "reply", partID: "text", delta: body })
      const text = `External reply: ${body}`
      return {
        text,
        sessionId,
        actualModel: { id: "fixture-selected" },
        final: { messageID: "reply", parts: [{ partID: "text", text }] },
      }
    }
    for (const step of scenario.steps ?? []) {
      host.step({ tool: step.tool, detail: step.detail })
      while (step.gate && !fs.existsSync(step.gate)) {
        task.signal.throwIfAborted()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    return { text: scenario.reply ?? "", sessionId }
  },
})
