import { join } from "node:path"
import { Http } from "@merakcode/util/http"
import { pathToFileURL } from "node:url"
import { response, sequence } from "./sdk-sequence"
import { Filesystem } from "@merakcode/util/filesystem"

export async function hooks(kind: "before" | "after" | "context" | "params") {
  const token = `HOOK_${crypto.randomUUID()}`
  const requests: { temperature?: number; topP?: number; maxTokens?: number }[] = []
  const observations: { system: boolean; message: boolean; transformedResult: boolean }[] = []
  let proxy: Http.Server | undefined
  const kit = await sequence(
    "read",
    false,
    ({ input, messages, outputs, project, send }) => {
      const system = messages.some(
        (item) => item.role === "system" && JSON.stringify(item.content).includes(`${token}_SYSTEM`),
      )
      const message = input.includes(`${token}_MESSAGE`)
      const transformedResult = outputs.some((item) => item.text.includes(`${token}_AFTER`))
      observations.push({ system, message, transformedResult })
      if (kind === "context" && (!system || !message)) throw new Error("S19 actual transformed model context absent")
      if (!outputs.length) return send("read", { filePath: join(project, "src/a.txt") })
      const marker = outputs[0].text.match(/MARKER_[a-f0-9-]+/)?.[0]
      if (!marker) throw new Error("S19 actual tool read marker missing")
      if (kind === "after" && !transformedResult) throw new Error("S19 transformed real tool output not consumed")
      if (outputs.length === 1)
        return send("write", {
          filePath: join(project, kind === "before" ? "before.txt" : "result.txt"),
          content: marker,
        })
      if (!outputs[1].text.includes("Wrote file")) throw new Error("S19 actual write did not complete")
      return response(`S19_DONE ${marker}`)
    },
    async ({ root, project }) => {
      const hook =
        kind === "before"
          ? `"tool.execute.before": async (input, output) => { if (input.tool === "write" && output.args.filePath === directory + "/before.txt") output.args.filePath = directory + "/after.txt" }`
          : kind === "after"
            ? `"tool.execute.after": async (input, output) => { if (input.tool === "read") output.output += "\\n${token}_AFTER" }`
            : kind === "context"
              ? `"experimental.chat.system.transform": async (input, output) => { output.system.push("${token}_SYSTEM") }, "experimental.chat.messages.transform": async (input, output) => { const user = output.messages.findLast((item) => item.info.role === "user"); const part = user?.parts.find((part) => part.type === "text"); if (part) part.text += " ${token}_MESSAGE" }`
              : `"chat.params": async (input, output) => { output.temperature = 0.23; output.topP = 0.67; output.maxOutputTokens = 321 }`
      const plugin = join(root, "sequence-plugin.ts")
      await Filesystem.write(plugin, `export default async ({ directory }) => ({ ${hook} })\n`)
      const file = join(project, "merakcode.json")
      const config = await Filesystem.readJson(file)
      config.plugin = [pathToFileURL(plugin).href]
      if (kind === "params") {
        const baseURL = config.provider.alibaba.options.baseURL
        proxy = await Http.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const body = await request.json()
            requests.push({
              temperature: body.temperature,
              topP: body.top_p,
              maxTokens: body.max_tokens ?? body.max_completion_tokens,
            })
            return fetch(`${baseURL}/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: request.signal,
            })
          },
        })
        config.provider.alibaba.options.baseURL = `${proxy.url.origin}/v1`
      }
      await Filesystem.write(file, JSON.stringify(config))
    },
  ).catch(async (error: unknown) => {
    await proxy?.stop(true)
    throw error
  })
  return {
    ...kit,
    token,
    hookObservations: observations,
    parameterRequests: requests,
    async finish(success: boolean) {
      try {
        await kit.finish(success)
      } finally {
        await proxy?.stop(true)
      }
    },
  }
}
