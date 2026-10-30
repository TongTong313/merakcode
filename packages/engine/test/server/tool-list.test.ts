import { expect, test } from "vitest"
import { Server } from "@merakcode/engine/app/server/server"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

// SDK tool.list: plugins and external clients use it to get the JSON Schema of each tool's parameters
test("GET /experimental/tool returns the JSON Schema of each tool's parameters", async () => {
  await using tmp = await tmpdir()
  const response = await Server.App().request("http://localhost/experimental/tool?provider=openai&model=gpt-5", {
    headers: { "x-merakcode-directory": encodeURIComponent(tmp.path) },
  })
  expect(response.status).toBe(200)
  const tools = (await response.json()) as { id: string; parameters: Record<string, any> }[]
  const read = tools.find((tool) => tool.id === "read")
  expect(read?.parameters.type).toBe("object")
  expect(read?.parameters.properties.filePath.type).toBe("string")
  expect(read?.parameters.required).toContain("filePath")
})
