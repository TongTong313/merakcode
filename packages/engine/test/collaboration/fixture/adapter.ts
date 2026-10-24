// A member adapter for tests, written with the adapter library as anyone would write one. Its argument is a JSON
// scenario: the permission requests to make, in order, then questions to ask; it replies with MerakCode's verdicts
// or the answers as JSON. With ignore it keeps running after it was told to stop; marker records that it was told.
import fs from "node:fs"
import { adapter, type Permission, type Question } from "@merakcode/sdk/adapter"

const scenario = JSON.parse(process.argv[2] ?? "{}") as {
  permissions?: Permission[]
  /** Makes the permission requests all at once, as Claude Code does with parallel tool calls */
  parallel?: boolean
  questions?: Question[]
  marker?: string
  ignore?: boolean
  unavailable?: string
  version?: string
  recommended?: string
  upgrade?: string
  /** Steps to report first; after one with a gate it waits until that file exists */
  steps?: { tool: string; detail?: string; gate?: string }[]
  /** A fixed reply instead of the verdicts */
  reply?: string
}

adapter({
  inspect: () => ({
    name: "Fixture",
    version: scenario.version ?? "1.0.0",
    recommended: scenario.recommended,
    upgrade: scenario.upgrade,
    unavailable: scenario.unavailable,
  }),
  async run(task, host) {
    if (scenario.marker) fs.writeFileSync(scenario.marker + ".pid", String(process.pid))
    task.signal.addEventListener("abort", () => {
      if (scenario.marker) fs.writeFileSync(scenario.marker, "cancelled")
      if (!scenario.ignore) process.exit(0)
      // Like an adapter still waiting on its CLI: it would stay up for a minute
      setTimeout(() => {}, 60_000)
    })
    for (const step of scenario.steps ?? []) {
      host.step({ tool: step.tool, detail: step.detail })
      while (step.gate && !fs.existsSync(step.gate)) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const verdicts = []
    if (scenario.parallel)
      verdicts.push(...(await Promise.all((scenario.permissions ?? []).map((request) => host.permission(request)))))
    else for (const request of scenario.permissions ?? []) verdicts.push(await host.permission(request))
    const answers = scenario.questions ? await host.question(scenario.questions) : undefined
    return { text: scenario.reply ?? JSON.stringify(answers ?? verdicts) }
  },
})
