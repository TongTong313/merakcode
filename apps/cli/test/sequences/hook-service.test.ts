import { expect, test } from "vitest"
import { join } from "node:path"
import { hooks } from "../fixture/hook-sequence"
import { drive } from "../fixture/sequence-driver"
import { Filesystem } from "@merakcode/util/filesystem"

for (const [id, kind] of [
  ["S19.02", "after"],
  ["S19.03", "context"],
  ["S19.04", "params"],
] as const) {
  test(`${id} P/MP real plugin transformation reaches provider and preserved product state`, async () => {
    const kit = await hooks(kind)
    let success = false
    try {
      const session = await kit.api("/session", "POST", { title: id })
      const input = `${id} 读取实际标记并保存`
      const result = await drive(kit, session.id, input, ["write"])
      const current = await kit.assertResult(session.id, result.userID, "S19_DONE")
      expect(await Filesystem.readText(join(kit.project, "result.txt"))).toBe(kit.marker)
      expect(await Filesystem.readText(join(kit.project, "src/a.txt"))).toBe(kit.marker)
      const history = await kit.api(`/session/${session.id}/message`)
      const user = history.find((entry: { info: { id: string } }) => entry.info.id === result.userID)
      expect(
        user.parts
          .filter((part: { type: string; synthetic?: boolean }) => part.type === "text" && !part.synthetic)
          .map((part: { text: string }) => part.text),
      ).toEqual([input])
      const disk = (
        await Filesystem.readText(join(kit.root, "data/merakcode/storage/transcript", `${session.id}.jsonl`))
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const textParts = user.parts.filter(
        (part: { type: string; synthetic?: boolean }) => part.type === "text" && !part.synthetic,
      )
      expect(
        textParts.map(
          (part: { id: string }) =>
            disk.findLast((line) => line.type === "part" && line.part.id === part.id)?.part.text,
        ),
      ).toEqual([input])
      if (kind === "after") {
        const read = current.flatMap((entry) => entry.parts).find((part) => part.tool === "read")
        expect(read?.state?.output).toContain(`${kit.token}_AFTER`)
        expect(disk.findLast((line) => line.type === "part" && line.part.id === read?.id)?.part.state.output).toContain(
          `${kit.token}_AFTER`,
        )
        expect(kit.hookObservations.some((item) => item.transformedResult)).toBe(true)
      }
      if (kind === "context") expect(kit.hookObservations.every((item) => item.system && item.message)).toBe(true)
      if (kind === "params") {
        expect(kit.parameterRequests.length).toBeGreaterThan(0)
        expect(
          kit.parameterRequests.every(
            (item) => item.temperature === 0.23 && item.topP === 0.67 && item.maxTokens === 321,
          ),
        ).toBe(true)
      }
      await Filesystem.write(
        join(kit.artifacts, "sequence.json"),
        JSON.stringify({
          id,
          layer: "P/MP",
          ui: "unverified",
          sessionID: session.id,
          userID: result.userID,
          observations: kit.hookObservations,
          parameters: kit.parameterRequests,
        }),
      )
      success = true
    } finally {
      await kit.finish(success)
    }
  }, 120_000)
}
