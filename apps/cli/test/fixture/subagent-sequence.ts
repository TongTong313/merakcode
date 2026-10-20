import { join } from "node:path"
import { response, sequence, until } from "./sdk-sequence"
import { Filesystem } from "@merakcode/util/filesystem"

// A real OpenAI-compatible usage chunk makes the product's child metrics meaningful.
async function metered(result: Response) {
  const chunk = {
    id: "sequence-usage",
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
  }
  return new Response((await result.text()).replace("data: [DONE]", `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]`), {
    headers: { "Content-Type": "text/event-stream" },
  })
}

export async function subagent(options: { verify?: () => Promise<void> } = {}) {
  const observations: { child: boolean; hint: boolean; results: string[] }[] = []
  const kit = await sequence(
    "read",
    false,
    async ({ input, outputs, project, send }) => {
      const child = input.includes("S17_CHILD")
      const hint = input.includes("subagent_type: sequence-child")
      observations.push({ child, hint, results: outputs.map((item) => item.name) })
      if (child && input.includes("FAIL"))
        return Response.json({ error: { message: "S17_SYNTHETIC_CHILD_FAILURE" } }, { status: 400 })
      if (child || input.includes("S17_FOLLOW")) {
        if (!outputs.length) return metered(send("read", { filePath: join(project, "src/a.txt") }))
        const marker = outputs[0].text.match(/MARKER_[a-f0-9-]+/)?.[0]
        if (!marker || outputs[0].name !== "read") throw new Error("S17 child/follow actual read absent")
        return metered(response(`${child ? "S17_CHILD_DONE" : "S17_FOLLOW_DONE"} ${marker}`))
      }
      if (input.includes("S17_EXPLICIT")) {
        if (!hint || !options.verify) throw new Error("S17 selected agent hint/verifier missing from parent request")
        await options.verify()
      }
      if (!outputs.length)
        return metered(
          send("subagent", {
            description: "S17 read current marker",
            subagent_type: "sequence-child",
            prompt: input.includes("S17_FAIL")
              ? "S17_CHILD_FAIL 明确失败"
              : "S17_CHILD_READ 读取src/a.txt并报告实际标记",
            mode: "fresh",
          }),
        )
      if (outputs[0].name !== "subagent") throw new Error("S17 actual child result missing")
      const marker = outputs[0].text.match(/MARKER_[a-f0-9-]+/)?.[0]
      if (input.includes("S17_FAIL")) {
        if (marker || outputs[0].text.includes("S17_CHILD_DONE")) throw new Error("S17 failed child fabricated success")
        if (outputs.length === 1) return metered(send("read", { filePath: join(project, "src/a.txt") }))
        const recovered = outputs[1].text.match(/MARKER_[a-f0-9-]+/)?.[0]
        if (!recovered) throw new Error("S17 parent recovery read missing")
        return metered(response(`S17_FAILURE_RECOVERED ${recovered}`))
      }
      if (!marker || !outputs[0].text.includes("S17_CHILD_DONE") || !outputs[0].text.includes("task_id:"))
        throw new Error("S17 parent did not consume successful real child result")
      return metered(response(`S17_PARENT_DONE ${marker}`))
    },
    async ({ project }) => {
      const file = join(project, "merakcode.json")
      const config = await Filesystem.readJson(file)
      config.agent = {
        "sequence-child": {
          mode: "subagent",
          description: "Read the current synthetic marker",
          permission: { read: "allow", write: "deny", edit: "deny" },
        },
      }
      await Filesystem.write(file, JSON.stringify(config))
    },
  )
  return {
    ...kit,
    childObservations: observations,
    async assertChildIdle(sessionID: string) {
      let first: string | undefined
      let last = "unobserved"
      let samples = 0
      let idle = false
      try {
        await until(
          async () => {
            last = (await kit.api("/session/status"))[sessionID]?.type ?? "idle"
            first ??= last
            samples++
            return last === "idle"
          },
          "completed child lifecycle returns idle",
          15_000,
        )
        idle = true
      } finally {
        await Filesystem.write(
          join(kit.artifacts, "child-lifecycle.json"),
          JSON.stringify({ sessionID, first, last, samples, idle }),
        )
      }
    },
  }
}
