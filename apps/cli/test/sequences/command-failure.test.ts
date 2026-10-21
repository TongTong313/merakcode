import { expect, test } from "vitest"
import { join } from "node:path"
import { response, sequence } from "../fixture/sdk-sequence"
import { drive } from "../fixture/sequence-driver"
import { runtime } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

test("S04.06 P/MM registered command template failure remains a command error and ordinary work recovers", async () => {
  let unexpected = 0
  const kit = await sequence(
    "read",
    false,
    ({ input, outputs, project, send }) => {
      if (input.includes("S04_BROKEN")) {
        unexpected++
        return response("S04_TEMPLATE_WAS_NOT_LOADED")
      }
      if (!input.includes("S04_FOLLOW")) throw new Error("S04 unexpected ordinary input")
      if (!outputs.length) return send("read", { filePath: join(project, "src/a.txt") })
      const marker = outputs[0].text.match(/MARKER_[a-f0-9-]+/)?.[0]
      if (!marker) throw new Error("S04 real recovery read missing")
      return response(`S04_RECOVERED ${marker}`)
    },
    async ({ project, root }) => {
      const file = join(project, "merakcode.json")
      const config = await Filesystem.readJson(file)
      config.mcp = {
        command: {
          type: "local",
          command: [...runtime, join(import.meta.dirname, "../fixture/command-failure-mcp.ts"), root],
          enabled: true,
        },
      }
      await Filesystem.write(file, JSON.stringify(config))
    },
  )
  let success = false
  try {
    const session = await kit.api("/session", "POST", { title: "S04.06" })
    const connected = await kit.api("/mcp")
    expect(connected.command.status).toBe("connected")
    const before = kit.modelRequests()
    const result = await fetch(`${kit.url}/session/${session.id}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-merakcode-directory": kit.project },
      body: JSON.stringify({
        command: "command:broken",
        arguments: "S04_BROKEN",
        agent: "build",
        model: "alibaba-cn/qwen-plus",
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const body: unknown = await result.json()
    const templateCalls = kit.modelRequests() - before
    const ledger = (await Filesystem.readText(join(kit.root, "command-mcp.jsonl")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; pid: number })
    expect(ledger.some((item) => item.method === "list")).toBe(true)
    expect(ledger.filter((item) => item.method === "get-failed").length).toBeGreaterThan(0)
    const after = await kit.api(`/session/${session.id}/message`)
    expect(
      after
        .flatMap((item: { parts: { type: string }[] }) => item.parts)
        .filter((part: { type: string }) => part.type === "tool"),
    ).toEqual([])
    const follow = await drive(kit, session.id, "S04_FOLLOW read src/a.txt")
    await kit.assertResult(session.id, follow.userID, "S04_RECOVERED")
    expect(await Filesystem.readText(join(kit.project, "src/keep.txt"))).toBe("KEEP_UNCHANGED")
    const name = body && typeof body === "object" && "name" in body ? body.name : undefined
    await Filesystem.write(
      join(kit.artifacts, "sequence.json"),
      JSON.stringify({
        id: "S04.06",
        layer: "P/MM",
        ui: "unverified",
        variant: "registered MCP command template retrieval failure",
        sessionID: session.id,
        follow,
        templateCalls,
        unexpected,
        status: result.status,
        errorName: name,
        ledger,
      }),
    )
    expect(templateCalls).toBe(0)
    expect(!result.ok || (typeof name === "string" && name.endsWith("Error"))).toBe(true)
    success = true
  } finally {
    await kit.finish(success)
  }
}, 120_000)
