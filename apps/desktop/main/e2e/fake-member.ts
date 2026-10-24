// A member adapter written with the adapter library, as anyone would write one. Its argument is a JSON scenario: the
// steps to report, waiting after one with a gate until that file exists, then the reply.
import fs from "node:fs"
import { adapter } from "@merakcode/sdk/adapter"

const scenario = JSON.parse(process.argv[2] ?? "{}") as {
  steps?: { tool: string; detail: string; gate?: string }[]
  reply?: string
}

adapter({
  inspect: () => ({ name: "Fake member", version: "1.0.0" }),
  async run(_task, host) {
    for (const step of scenario.steps ?? []) {
      host.step({ tool: step.tool, detail: step.detail })
      while (step.gate && !fs.existsSync(step.gate)) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return { text: scenario.reply ?? "" }
  },
})
