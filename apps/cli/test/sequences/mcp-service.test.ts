import { expect, test } from "vitest"
import { join } from "node:path"
import { mcp, ledger } from "../fixture/mcp-sequence"
import { drive } from "../fixture/sequence-driver"
import { until } from "../fixture/sdk-sequence"
import { Filesystem } from "@merakcode/util/filesystem"

test("S06 concurrent MCP selection ends disabled in both backend and session worker", async () => {
  const kit = await mcp()
  let success = false
  try {
    const session = await kit.api("/session", "POST", { title: "S06 serialized selection" })
    const first = await drive(kit, session.id, "S06_LOOKUP 先运行真实 lookup")
    await kit.assertResult(session.id, first.userID, "S06_DONE")
    const initialized = (await ledger(kit.root)).filter((item) => item.method === "initialized").length
    const connecting = kit.api("/mcp/sequence/connect", "POST")
    await until(
      async () => (await ledger(kit.root)).filter((item) => item.method === "initialized").length > initialized,
      "second MCP connection started",
    )
    const disconnecting = kit.api("/mcp/sequence/disconnect", "POST")
    await Promise.all([connecting, disconnecting])
    expect((await kit.api("/mcp")).sequence.status).toBe("disabled")
    const calls = (await ledger(kit.root)).filter((item) => item.method === "call").length
    const unavailable = await drive(kit, session.id, "S06_UNAVAILABLE 并发切换后不得再调用 lookup")
    const messages = await kit.api(`/session/${session.id}/message`)
    expect(
      messages.some(
        (item: { info: { parentID?: string; time: { completed?: number } }; parts: { text?: string }[] }) =>
          item.info.parentID === unavailable.userID &&
          Boolean(item.info.time.completed) &&
          item.parts.some((part) => part.text?.includes("S06_UNAVAILABLE_DONE")),
      ),
    ).toBe(true)
    expect(kit.observations.at(-1)?.tools.includes("sequence_lookup")).toBe(false)
    expect((await ledger(kit.root)).filter((item) => item.method === "call")).toHaveLength(calls)
    success = true
  } finally {
    await kit.finish(success)
  }
}, 120_000)

test("S06 deleting MCP removes stale tool from the existing session worker", async () => {
  const kit = await mcp()
  let success = false
  try {
    const session = await kit.api("/session", "POST", { title: "S06 remove existing worker" })
    const first = await drive(kit, session.id, "S06_LOOKUP 删除前使用 lookup")
    await kit.assertResult(session.id, first.userID, "S06_DONE")
    const calls = (await ledger(kit.root)).filter((item) => item.method === "call").length
    await kit.api("/mcp/sequence?scope=project", "DELETE")
    const next = await drive(kit, session.id, "S06_UNAVAILABLE 删除后不使用旧工具")
    const messages = await kit.api(`/session/${session.id}/message`)
    expect(
      messages.some(
        (item: { info: { parentID?: string; time: { completed?: number } }; parts: { text?: string }[] }) =>
          item.info.parentID === next.userID &&
          Boolean(item.info.time.completed) &&
          item.parts.some((part) => part.text?.includes("S06_UNAVAILABLE_DONE")),
      ),
    ).toBe(true)
    expect(kit.observations.at(-1)?.tools.includes("sequence_lookup")).toBe(false)
    expect((await ledger(kit.root)).filter((item) => item.method === "call")).toHaveLength(calls)
    success = true
  } finally {
    await kit.finish(success)
  }
}, 120_000)

test("S06 MCP server process dies: its tools are withdrawn, ordinary read stays available", async () => {
  const kit = await mcp()
  let success = false
  try {
    expect((await kit.api("/mcp")).sequence.status).toBe("connected")
    // The server process exits mid-session and cannot start again
    await Filesystem.write(join(kit.root, "mcp-start-fail"), "1")
    const server = (await ledger(kit.root)).findLast((item) => item.method === "initialized")!
    process.kill(server.pid)
    await until(async () => (await kit.api("/mcp")).sequence.status === "failed", "MCP marked failed after exit")
    const session = await kit.api("/session", "POST", { title: "S06 optional MCP failure" })
    const result = await drive(kit, session.id, "S06_READ 可选 MCP 故障后读取普通文件")
    await kit.assertResult(session.id, result.userID, "S06_READ_DONE")
    expect(kit.observations[0].tools.includes("sequence_lookup")).toBe(false)
    success = true
  } finally {
    await kit.finish(success)
  }
}, 120_000)

test("S06.01 P/MM configured enabled MCP initializes and its real lookup result is consumed", async () => {
  const kit = await mcp()
  let success = false
  try {
    const session = await kit.api("/session", "POST", { title: "S06.01" })
    const result = await drive(kit, session.id, "S06_LOOKUP 使用已配置的 lookup 读取标记")
    const current = await kit.assertResult(session.id, result.userID, "S06_DONE")
    const tools = current.flatMap((item) => item.parts).filter((part) => part.type === "tool")
    expect(tools).toHaveLength(1)
    expect(tools[0].state?.status).toBe("completed")
    const calls = await ledger(kit.root)
    expect(calls.filter((item) => item.method === "call").map((item) => item.key)).toEqual(["current"])
    expect(calls.some((item) => item.method === "initialized")).toBe(true)
    const status = await kit.api("/mcp")
    expect(Object.keys(status)).toEqual(["sequence"])
    expect(status.sequence.status).toBe("connected")
    expect(status.sequence.scope).toBe("project")
    await Filesystem.write(
      join(kit.artifacts, "sequence.json"),
      JSON.stringify(
        {
          id: "S06.01",
          layer: "P/MM",
          ui: "unverified",
          sessionID: session.id,
          ...result,
          calls,
        },
        null,
        2,
      ),
    )
    success = true
  } finally {
    await kit.finish(success)
  }
}, 120_000)
