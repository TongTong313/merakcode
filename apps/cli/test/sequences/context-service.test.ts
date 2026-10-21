import { expect, test } from "vitest"
import { rename } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { context } from "../fixture/context-sequence"
import { drive } from "../fixture/sequence-driver"
import { Filesystem } from "@merakcode/util/filesystem"

test("S07.03 P/M selected file renamed before submission reports missing content then valid path recovers", async () => {
  const kit = await context("attachment")
  let success = false
  try {
    const session = await kit.api("/session", "POST", { title: "S07.03" })
    const part = {
      type: "file",
      mime: "text/plain",
      filename: "src/a.txt",
      url: pathToFileURL(join(kit.project, "src/a.txt")).href,
    }
    await rename(join(kit.project, "src/a.txt"), join(kit.project, "src/moved.txt"))
    const submit = (text: string, file: typeof part) =>
      kit.api(`/session/${session.id}/message`, "POST", {
        agent: "build",
        model: { providerID: "alibaba-cn", modelID: "qwen-plus" },
        parts: [{ type: "text", text }, file],
      })
    await submit("S07_MISSING 读取已选文件", part)
    const missing = await kit.submitted(session.id, "S07_MISSING 读取已选文件")
    const before = await kit.api(`/session/${session.id}/message`)
    const supplied = before.find((item: { info: { id: string } }) => item.info.id === missing)
    expect(supplied.parts.some((item: { text?: string }) => item.text?.includes("Read tool failed to read"))).toBe(true)
    expect(supplied.parts.some((item: { text?: string }) => item.text?.includes(kit.marker))).toBe(false)
    await submit("S07_RECOVER 用正确的新路径读取", {
      ...part,
      filename: "src/moved.txt",
      url: pathToFileURL(join(kit.project, "src/moved.txt")).href,
    })
    const recovered = await kit.submitted(session.id, "S07_RECOVER 用正确的新路径读取")
    const current = await kit.assertResult(session.id, recovered, "S07_ATTACHED_DONE")
    expect(current.flatMap((item) => item.parts).filter((part) => part.type === "tool")).toHaveLength(0)
    expect(await Filesystem.isFile(join(kit.project, "src/a.txt"))).toBe(false)
    await Filesystem.write(
      join(kit.artifacts, "sequence.json"),
      JSON.stringify({ id: "S07.03", layer: "P/M", ui: "unverified", sessionID: session.id, missing, recovered }),
    )
    success = true
  } finally {
    await kit.finish(success)
  }
}, 120_000)

for (const item of [
  { id: "S07.04", mode: "hierarchy" as const, answer: "S07_RULE_DONE", tools: ["read"] },
  { id: "S07.05", mode: "auto" as const, answer: "S07_AUTO_DONE", tools: ["grep", "read", "edit"] },
]) {
  test(`${item.id} P/M actual file access consumes scoped instructions`, async () => {
    const kit = await context(item.mode)
    let success = false
    try {
      const session = await kit.api("/session", "POST", { title: item.id })
      const original = await Filesystem.readText(join(kit.project, "src/calc.ts"))
      const result = await drive(
        kit,
        session.id,
        item.mode === "auto" ? "S07_AUTO 搜索并修复加法函数" : "S07_HIERARCHY 读取 src/a.txt 并报告标记",
        ["grep", "edit"],
      )
      const current = await kit.assertResult(session.id, result.userID, item.answer)
      expect(
        current
          .flatMap((entry) => entry.parts)
          .filter((part) => part.type === "tool")
          .map((part) => ({ tool: part.tool, status: part.state?.status })),
      ).toEqual(item.tools.map((tool) => ({ tool, status: "completed" })))
      expect(kit.contextObservations.some((entry) => entry.rule)).toBe(true)
      expect(await Filesystem.readText(join(kit.project, "src/calc.ts"))).toBe(
        item.mode === "auto" ? original.replace("a - b", "a + b") : original,
      )
      expect(await Filesystem.readText(join(kit.project, "src/keep.txt"))).toBe("KEEP_UNCHANGED")
      await Filesystem.write(
        join(kit.artifacts, "sequence.json"),
        JSON.stringify({
          id: item.id,
          layer: "P/M",
          ui: "unverified",
          sessionID: session.id,
          ...result,
          observations: kit.contextObservations,
        }),
      )
      success = true
    } finally {
      await kit.finish(success)
    }
  }, 120_000)
}

test("S07.08 P/M external file change is reread after real history without rewriting old rounds", async () => {
  const kit = await context("refresh")
  let success = false
  try {
    const session = await kit.api("/session", "POST", { title: "S07.08" })
    for (const input of ["S07_FIRST 读取 src/a.txt", "S07_WRITE 将读到的标记保存为 history.txt"]) {
      const result = await drive(kit, session.id, input, ["write"])
      await kit.assertResult(session.id, result.userID, "S07_INITIAL_DONE")
    }
    expect(await Filesystem.readText(join(kit.project, "history.txt"))).toBe(kit.marker)
    const before = await kit.api(`/session/${session.id}/message`)
    const fresh = `FRESH_${crypto.randomUUID()}`
    await Filesystem.write(join(kit.project, "src/a.txt"), `${kit.marker}\n${fresh}`)
    const result = await drive(kit, session.id, "S07_FOLLOW 文件已在外部修改，请重新读取")
    const current = await kit.assertResult(session.id, result.userID, "S07_FRESH_DONE")
    expect(current.flatMap((entry) => entry.parts).some((part) => part.text?.includes(fresh))).toBe(true)
    expect(
      current
        .flatMap((entry) => entry.parts)
        .filter((part) => part.type === "tool")
        .map((part) => ({ tool: part.tool, status: part.state?.status })),
    ).toEqual([{ tool: "read", status: "completed" }])
    const after = await kit.api(`/session/${session.id}/message`)
    expect(
      after.filter((entry: { info: { id: string } }) =>
        before.some((old: { info: { id: string } }) => old.info.id === entry.info.id),
      ),
    ).toEqual(before)
    expect(await Filesystem.readText(join(kit.project, "history.txt"))).toBe(kit.marker)
    await Filesystem.write(
      join(kit.artifacts, "sequence.json"),
      JSON.stringify({
        id: "S07.08",
        layer: "P/M",
        ui: "unverified",
        sessionID: session.id,
        ...result,
        observations: kit.contextObservations,
      }),
    )
    success = true
  } finally {
    await kit.finish(success)
  }
}, 120_000)
