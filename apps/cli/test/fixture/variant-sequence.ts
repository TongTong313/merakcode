import { join } from "node:path"
import { Http } from "@merakcode/util/http"
import { response, sequence } from "./sdk-sequence"
import { Filesystem } from "@merakcode/util/filesystem"

export async function variants(toggle: boolean) {
  let proxy: Http.Server | undefined
  const parameters: { tag: string; model: string; thinking?: boolean; budget?: number }[] = []
  const kit = await sequence(
    "read",
    false,
    ({ input, outputs, project, send }) => {
      const tag = input.match(/S02_VARIANT_[AB]/)?.[0]
      if (!tag) throw new Error("S02 variant current user tag missing")
      if (!outputs.length) return send("read", { filePath: join(project, "src/a.txt") })
      const marker = outputs[0].text.match(/MARKER_[a-f0-9-]+/)?.[0]
      if (!marker || outputs[0].name !== "read") throw new Error("S02 variant actual read marker missing")
      return response(`${tag}_DONE ${marker}`)
    },
    async ({ project }) => {
      const file = join(project, "merakcode.json")
      const config = await Filesystem.readJson(file)
      const base = config.provider.alibaba.options.baseURL
      config.provider.alibaba.models = {
        "qwen-plus": {
          name: "S02 Variant Model",
          options: { enable_thinking: true, thinking_budget: 128 },
          variants: toggle
            ? { off: { enable_thinking: false } }
            : {
                low: { enable_thinking: true, thinking_budget: 128 },
                medium: { disabled: true },
                high: { enable_thinking: true, thinking_budget: 256 },
              },
        },
      }
      proxy = await Http.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = await request.json()
          const user = body.messages.findLast((item: { role: string }) => item.role === "user")
          const tag = JSON.stringify(user?.content).match(/S02_VARIANT_[AB]/)?.[0]
          if (body.tools?.length && tag)
            parameters.push({ tag, model: body.model, thinking: body.enable_thinking, budget: body.thinking_budget })
          return fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: request.signal,
          })
        },
      })
      config.provider.alibaba.options.baseURL = `${proxy.url.origin}/v1`
      await Filesystem.write(file, JSON.stringify(config))
    },
  ).catch(async (error: unknown) => {
    await proxy?.stop(true)
    throw error
  })
  return {
    ...kit,
    parameters,
    async finish(success: boolean) {
      try {
        await kit.finish(success)
      } finally {
        await proxy?.stop(true)
      }
    },
  }
}
