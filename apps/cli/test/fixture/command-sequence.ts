import { join } from "node:path"
import { z } from "zod"
import { response, sequence } from "./sdk-sequence"
import { drive } from "./sequence-driver"
import { Filesystem } from "@merakcode/util/filesystem"

export async function commands() {
  const args = "S04_ARG_第一行 & <tag>\nS04_ARG_第二行"
  const observations: { template: boolean; report: boolean; tools: string[] }[] = []
  const kit = await sequence(
    "read",
    false,
    ({ input, messages, outputs, project, send }) => {
      const value: unknown = JSON.parse(input)
      const text =
        typeof value === "string"
          ? value
          : z
              .array(z.object({ text: z.string() }))
              .parse(value)
              .map((part) => part.text)
              .join("")
      const template = text.startsWith("S04_TEMPLATE\n")
      const supplied = template ? text.slice("S04_TEMPLATE\n".length) : ""
      if (template && supplied !== args)
        throw new Error("S04 command arguments changed or duplicated in actual model request")
      if (text.includes("S04_UNKNOWN") && !text.startsWith("/no-such-command S04_UNKNOWN"))
        throw new Error("S04 unknown slash was not passed as literal user text")
      const report = JSON.stringify(messages).includes("## 上下文报告")
      if (text.includes("S04_CONTEXT") && !report)
        throw new Error("S04 synchronous report did not reach follow-up model")
      observations.push({ template, report, tools: outputs.map((item) => item.name) })
      if (!outputs.length) return send("read", { filePath: join(project, "src/a.txt") })
      const marker = outputs[0].text.match(/MARKER_[a-f0-9-]+/)?.[0]
      if (outputs[0].name !== "read" || !marker) throw new Error("S04 current real read missing")
      if (outputs.length === 1 && (template || text.includes("S04_PREP_WRITE")))
        return send("write", {
          filePath: join(project, template ? "template.txt" : "history.txt"),
          content: template ? `${marker}\n${supplied}` : marker,
        })
      if ((template || text.includes("S04_PREP_WRITE")) && !outputs[1]?.text.includes("Wrote file"))
        throw new Error("S04 actual command/history write missing")
      const tag = template
        ? "TEMPLATE"
        : text.includes("S04_TRANSFER")
          ? "TRANSFER"
          : text.includes("S04_NEW")
            ? "NEW"
            : text.includes("S04_UNKNOWN")
              ? "UNKNOWN"
              : text.includes("S04_CONTEXT")
                ? "CONTEXT"
                : "PREP"
      return response(`S04_${tag}_DONE ${marker}`)
    },
    async ({ project }) => {
      const path = join(project, "merakcode.json")
      const config = await Filesystem.readJson(path)
      config.command = {
        sequence: { template: "S04_TEMPLATE\n$ARGUMENTS", agent: "build", model: "alibaba-cn/qwen-plus" },
      }
      await Filesystem.write(path, JSON.stringify(config))
    },
  )
  return { ...kit, args, commandObservations: observations }
}

export async function commandHistory(kit: Awaited<ReturnType<typeof commands>>, sessionID: string) {
  for (const input of ["S04_PREP_READ 读取 src/a.txt", "S04_PREP_WRITE 把标记写入 history.txt"]) {
    const result = await drive(kit, sessionID, input, ["write"])
    await kit.assertResult(sessionID, result.userID, "S04_PREP_DONE")
  }
  return kit.api(`/session/${sessionID}/message`)
}
