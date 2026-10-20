import { expect, test } from "vitest"
import { join } from "node:path"
import { z } from "zod"
import { subagent } from "../fixture/subagent-sequence"
import { drive } from "../fixture/sequence-driver"
import { Filesystem } from "@merakcode/util/filesystem"

for (const id of ["S17.02", "S17.03"]) {
  test(`${id} P/M ordinary delegation executes a real child and parent consumes its actual outcome`, async () => {
    const kit = await subagent()
    let success = false
    try {
      const session = await kit.api("/session", "POST", { title: id })
      const failed = id === "S17.03"
      const result = await drive(
        kit,
        session.id,
        failed ? "S17_FAIL 委派明确失败后恢复" : "S17_ORDINARY 委派读取实际文件",
        ["subagent"],
      )
      const current = await kit.assertResult(
        session.id,
        result.userID,
        failed ? "S17_FAILURE_RECOVERED" : "S17_PARENT_DONE",
        failed ? 1 : 0,
      )
      const children = await kit.api(`/session/${session.id}/children`)
      expect(children).toHaveLength(1)
      expect(children[0].parentID).toBe(session.id)
      const history = await kit.api(`/session/${children[0].id}/message`)
      const childUser = history.find((entry: { info: { role: string } }) => entry.info.role === "user")
      expect(childUser.info.agent).toBe("sequence-child")
      const assistants = history.filter(
        (entry: { info: { role: string; parentID?: string } }) =>
          entry.info.role === "assistant" && entry.info.parentID === childUser.info.id,
      )
      expect(assistants.length).toBeGreaterThan(0)
      expect(
        assistants.every((entry: { info: { time: { completed?: number } } }) => Boolean(entry.info.time.completed)),
      ).toBe(true)
      const tool = current.flatMap((entry) => entry.parts).find((part) => part.tool === "subagent")
      expect(tool?.state?.status).toBe(failed ? "error" : "completed")
      if (failed) {
        expect(assistants.some((entry: { info: { error?: unknown } }) => entry.info.error !== undefined)).toBe(true)
        expect(
          history
            .flatMap((entry: { parts: { tool?: string }[] }) => entry.parts)
            .some((part: { tool?: string }) => part.tool === "write"),
        ).toBe(false)
        const follow = await drive(kit, session.id, "S17_FOLLOW 失败后独立读取")
        await kit.assertResult(session.id, follow.userID, "S17_FOLLOW_DONE")
      } else {
        await kit.assertResult(children[0].id, childUser.info.id, "S17_CHILD_DONE")
        const state = z
          .object({
            metadata: z.object({ sessionId: z.string(), messageIds: z.array(z.string()), totalTokens: z.number() }),
          })
          .parse(tool?.state)
        expect(state.metadata.sessionId).toBe(children[0].id)
        expect(state.metadata.messageIds).toEqual(assistants.map((entry: { info: { id: string } }) => entry.info.id))
        expect(state.metadata.totalTokens).toBeGreaterThan(0)
      }
      expect(kit.childObservations.some((item) => !item.child && item.results.includes("subagent"))).toBe(true)
      await Filesystem.write(
        join(kit.artifacts, "sequence.json"),
        JSON.stringify({
          id,
          layer: "P/M",
          ui: "unverified",
          sessionID: session.id,
          userID: result.userID,
          childSessionID: children[0].id,
          childUserID: childUser.info.id,
          failed,
          observations: kit.childObservations,
        }),
      )
      if (!failed) await kit.assertChildIdle(children[0].id)
      success = true
    } finally {
      await kit.finish(success)
    }
  }, 120_000)
}
