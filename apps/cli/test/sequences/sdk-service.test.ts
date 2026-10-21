import { expect, test } from "vitest"
import { join } from "node:path"
import { sequence } from "../fixture/sdk-sequence"
import { Filesystem } from "@merakcode/util/filesystem"

const fault = process.env.MERAKCODE_I1_FAULT === "1"
test(`I1 S06.06 service/MCP ${fault ? "failure detector" : "error correction and real result"}`, async () => {
  const kit = await sequence("mcp", fault)
  let success = false
  try {
    const session = await kit.api("/session", "POST", { title: "I1 S06.06" })
    await kit.api(`/session/${session.id}/message`, "POST", {
      agent: "build",
      model: { providerID: "alibaba-cn", modelID: "qwen-plus" },
      parts: [{ type: "text", text: "I1_MCP lookup the current synthetic marker." }],
    })
    const userID = await kit.submitted(session.id, "I1_MCP lookup the current synthetic marker.")
    const ledger = (await Filesystem.readText(join(kit.root, "mcp.jsonl")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(ledger.filter((item) => item.method === "call").map((item) => item.key)).toEqual(["bad", "current"])
    expect(kit.observations.some((item) => item.resultNames.length === 2)).toBe(true)
    if (fault)
      await expect(kit.assertResult(session.id, userID)).rejects.toThrow(
        "I1_ORACLE: missing visible result from real marker",
      )
    else {
      const history = await kit.assertResult(session.id, userID)
      const tools = history.flatMap((item) => item.parts).filter((part) => part.type === "tool")
      expect(tools).toHaveLength(2)
      expect(
        tools[0].state?.status === "error" ||
          (tools[0].state?.metadata as { mcpIsError?: boolean } | undefined)?.mcpIsError === true,
      ).toBe(true)
      expect(tools[1].state?.status).toBe("completed")
      expect(await kit.api("/permission")).toEqual([])
    }
    success = true
  } finally {
    await kit.finish(success)
  }
}, 120_000)
