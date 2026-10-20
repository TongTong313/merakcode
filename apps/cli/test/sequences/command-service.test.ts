import { expect, test } from "vitest"
import { join } from "node:path"
import { commands, commandHistory } from "../fixture/command-sequence"
import { Filesystem } from "@merakcode/util/filesystem"

test("S04.03 P/M synchronous context report is consumed by its real follow-up read", async () => {
  const kit = await commands()
  let success = false
  try {
    const session = await kit.api("/session", "POST", { title: "S04.03" })
    await commandHistory(kit, session.id)
    const input = "S04_CONTEXT 读取 src/a.txt 并报告标记"
    await kit.api(`/session/${session.id}/command`, "POST", {
      command: "context",
      arguments: input,
      agent: "build",
      model: "alibaba/qwen-plus",
    })
    const userID = await kit.submitted(session.id, input)
    const current = await kit.assertResult(session.id, userID, "S04_CONTEXT_DONE")
    expect(
      current
        .flatMap((entry) => entry.parts)
        .filter((part) => part.type === "tool")
        .map((part) => part.tool),
    ).toEqual(["read"])
    expect(kit.commandObservations.slice(-2).every((item) => item.report)).toBe(true)
    await Filesystem.write(
      join(kit.artifacts, "sequence.json"),
      JSON.stringify({
        id: "S04.03",
        layer: "P/M",
        ui: "unverified",
        sessionID: session.id,
        userID,
        observations: kit.commandObservations,
      }),
    )
    success = true
  } finally {
    await kit.finish(success)
  }
}, 120_000)
