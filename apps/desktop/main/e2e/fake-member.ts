// A member adapter written with the adapter library, as anyone would write one. Its argument is a JSON scenario: the
// steps to report, waiting after one with a gate until that file exists, then the reply.
import fs from "node:fs"
import { adapter } from "@merakcode/sdk/adapter"
import { randomUUID } from "node:crypto"

const scenario = JSON.parse(process.argv[2] ?? "{}") as {
  tools?: { name: string; input: { url?: string; questions?: any[] } }[]
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
      questions: true,
      draftOnly: true,
      control: {
        reportedOperations: ["read", "write", "command", "network", "tool"],
        cancellation: "task",
        liveMode: true,
        limitations: [],
      },
    },
  }),
  async run(task, host) {
    const sessionId = task.resume ?? `e2e-member-${randomUUID()}`
    await host.sessionStarted({ sessionId })
    if (scenario.tools) {
      const replies: string[] = []
      for (const [index, tool] of scenario.tools.entries()) {
        if (tool.name === "AskUserQuestion") {
          const questions = tool.input.questions ?? []
          const answers = await host.question(questions)
          replies.push(
            JSON.stringify(
              Object.fromEntries(questions.map((question, i) => [question.question, answers[i]?.join(", ")])),
            ),
          )
          continue
        }
        const url = tool.input.url!
        const id = `network-${index}`
        const verdict = await host.operationStart({
          id,
          isolation: "none",
          request: { kind: "network", host: new URL(url).hostname, url },
        })
        if (verdict.allow) {
          verdict.signal.throwIfAborted()
          await host.operationFinish({ id, status: "completed" })
        }
        replies.push(
          verdict.allow ? `WebFetch allowed ${JSON.stringify(tool.input)}` : `WebFetch denied: ${verdict.message}`,
        )
      }
      return { text: replies.join("\n"), sessionId }
    }
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
