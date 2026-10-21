import { join } from "node:path"
import { Network } from "@merakcode/util/network"
import { Http } from "@merakcode/util/http"
import { response, sequence } from "./sdk-sequence"
import { Filesystem } from "@merakcode/util/filesystem"

export async function unavailableModel() {
  let proxy: Http.Server | undefined
  let port = 0
  let base = ""
  const models: string[] = []
  const kit = await sequence(
    "read",
    false,
    ({ model, outputs, project, send }) => {
      models.push(model)
      if (model !== "qwen-max") throw new Error("S02 unavailable selected model silently changed")
      if (!outputs.length) return send("read", { filePath: join(project, "src/a.txt") })
      const marker = outputs[0].text.match(/MARKER_[a-f0-9-]+/)?.[0]
      if (!marker || outputs[0].name !== "read") throw new Error("S02 unavailable model actual recovered read missing")
      return response(`S02_RECOVERED ${marker}`)
    },
    async ({ project }) => {
      const file = join(project, "merakcode.json")
      const config = await Filesystem.readJson(file)
      base = config.provider["alibaba-cn"].options.baseURL
      port = await Network.freePort()
      config.model = "alibaba-cn/qwen-max"
      config.small_model = "alibaba-cn/qwen-max"
      config.provider["alibaba-cn"].options.baseURL = `http://127.0.0.1:${port}/v1`
      await Filesystem.write(file, JSON.stringify(config))
    },
    { models: ["qwen-max"] },
  )
  return {
    ...kit,
    selectedModels: models,
    port,
    async recover() {
      proxy = await Http.serve({
        hostname: "127.0.0.1",
        port,
        fetch: async (request) =>
          fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: await request.text(),
            signal: request.signal,
          }),
      })
    },
    async finish(success: boolean) {
      try {
        await kit.finish(success)
      } finally {
        await proxy?.stop(true)
      }
    },
  }
}
