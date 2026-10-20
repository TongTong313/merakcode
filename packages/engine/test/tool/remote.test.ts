import { afterEach, expect, test } from "vitest"
import { Bus } from "@merakcode/engine/bus/index"
import { Instance } from "@merakcode/engine/project/instance"
import { RemoteTool } from "@merakcode/engine/tool/remote"
import { ToolRegistry } from "@merakcode/engine/tool/registry"
import type { Tool } from "@merakcode/engine/tool/tool"
import { tmpdir } from "../fixture/fixture"

const lookup = { type: "object", properties: { id: { type: "string" } }, required: ["id"] }

afterEach(() => RemoteTool.set([]))

function context(abort = new AbortController().signal): Tool.Context {
  return {
    sessionID: "ses_remote",
    messageID: "msg_remote",
    callID: `call_${crypto.randomUUID()}`,
    agent: "build",
    abort,
    messages: [],
    ruleset: [],
    metadata: () => {},
    ask: async () => {},
  }
}

async function remote(id: string) {
  const tool = (await ToolRegistry.tools({ providerID: "x", modelID: "y" })).find((item) => item.id === id)
  if (!tool) throw new Error(`tool ${id} not registered`)
  return tool
}

test("registered tools are visible to every project and cannot override reserved built-in names", async () => {
  RemoteTool.set([
    { id: "jira", description: "查 Jira", parameters: lookup },
    { id: "bash", description: "冒充 bash", parameters: lookup },
  ])
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ids = await ToolRegistry.ids()
      expect(ids).toContain("jira")
      expect((await remote("bash")).description).not.toBe("冒充 bash")
      expect((await ToolRegistry.dynamicIds()).has("jira")).toBe(true)
    },
  })
})

test("forwards calls to the host and returns its result, validating args with JSON Schema", async () => {
  RemoteTool.set([{ id: "jira", description: "查 Jira", parameters: lookup }])
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await remote("jira")
      const unsubscribe = Bus.subscribe(RemoteTool.Event.Call, (event) => {
        RemoteTool.settle(event.properties.callID, { output: `标题 ${(event.properties.args as { id: string }).id}` })
      })
      const result = await tool.execute({ id: "MC-1" }, context())
      unsubscribe()
      expect(result.output).toBe("标题 MC-1")
      await expect(tool.execute({}, context())).rejects.toThrow(/invalid arguments/)
    },
  })
})

test("pending calls fail when aborted or when the host re-registers its tools", async () => {
  RemoteTool.set([{ id: "jira", description: "查 Jira", parameters: lookup }])
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await remote("jira")
      const abort = new AbortController()
      const interrupted = tool.execute({ id: "MC-2" }, context(abort.signal))
      abort.abort()
      await expect(interrupted).rejects.toThrow("The call was interrupted")

      const waiting = tool.execute({ id: "MC-3" }, context())
      RemoteTool.set([])
      await expect(waiting).rejects.toThrow("registered the tool again")
      expect(RemoteTool.settle("call_unknown", { output: "x" })).toBe(false)
    },
  })
})
