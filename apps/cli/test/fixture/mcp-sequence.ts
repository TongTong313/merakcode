import { join } from "node:path"
import { z } from "zod"
import { response, sequence } from "./sdk-sequence"
import { Filesystem } from "@merakcode/util/filesystem"

export async function ledger(root: string) {
  const text = await Filesystem.readText(join(root, "mcp.jsonl")).catch(() => "")
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      z
        .object({
          method: z.string(),
          key: z.string().optional(),
          argument: z.string().optional(),
          server: z.string().optional(),
          pid: z.number(),
        })
        .parse(JSON.parse(line)),
    )
}

export function mcp(enabled = true, fail = false, retained = false) {
  return sequence(
    "mcp",
    false,
    ({ input, outputs, project, send, tools }) => {
      if (input.includes("S06_UNAVAILABLE")) {
        if (tools.includes("sequence_lookup") && !outputs.length) return send("sequence_lookup", { key: "current" })
        const stale = outputs[0]?.text.match(/MARKER_[a-f0-9-]+/)?.[0]
        if (stale) return response(`S06_STALE_CALL_DONE ${stale}`)
        return response("S06_UNAVAILABLE_DONE")
      }
      if (input.includes("S06_READ")) {
        if (!outputs.length) return send("read", { filePath: join(project, "input.txt") })
        const marker = outputs[0].text.match(/MARKER_[a-f0-9-]+/)?.[0]
        if (outputs[0].name !== "read" || !marker) throw new Error("S06 ordinary follow-up did not consume real read")
        return response(`S06_READ_DONE ${marker}`)
      }
      if (!input.includes("S06_LOOKUP")) throw new Error("S06 unexpected model input")
      const tool = input.includes("S06_LOOKUP_RETAINED") ? "retained_lookup" : "sequence_lookup"
      if (!outputs.length) return send(tool, { key: "current" })
      const marker = outputs[0].text.match(/MARKER_[a-f0-9-]+/)?.[0]
      if (outputs[0].name !== tool || !marker) throw new Error("S06 real MCP lookup result missing")
      if (outputs.length !== 1) throw new Error("S06 duplicate MCP call")
      return response(`${input.includes("S06_LOOKUP_RECONNECT") ? "S06_RECONNECTED_DONE" : "S06_DONE"} ${marker}`)
    },
    async ({ project, root }) => {
      const path = join(project, "merakcode.json")
      const config = await Filesystem.readJson(path)
      config.mcp.sequence.enabled = enabled
      await Filesystem.write(path, JSON.stringify(config))
      if (fail) await Filesystem.write(join(root, "mcp-start-fail"), "1")
      if (retained)
        await Filesystem.write(
          join(root, "merakcode.json"),
          JSON.stringify({
            mcp: { retained: { ...config.mcp.sequence, command: [...config.mcp.sequence.command, "retained"] } },
          }),
        )
    },
  )
}
