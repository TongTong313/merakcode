import { expect, test } from "vitest"
import { Server } from "../../src/app/server/server"
import { Session } from "../../src/agent/session"
import { SessionPlan } from "../../src/agent/session/plan"
import { Instance } from "../../src/infra/project/instance"
import { tmpdir } from "../fixture/fixture"

test("plan chunks cover more than twenty paragraphs and a long final line without changing idle state", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const content =
        Array.from({ length: 25 }, (_, index) => `Paragraph ${index}\n\n`).join("") + "x".repeat(50000) + "END"
      await SessionPlan.save({ sessionID: session.id, content, source: "human", expectedRevision: 0 })
      let offset = 0
      let restored = ""
      for (;;) {
        const response = await Server.App().request(
          `/session/${session.id}/plan/chunk?directory=${encodeURIComponent(tmp.path)}&offset=${offset}&limit=4000`,
        )
        expect(response.status).toBe(200)
        const chunk = await response.json()
        restored += chunk.content
        if (chunk.nextOffset === undefined) break
        expect(chunk.nextOffset).toBeGreaterThan(offset)
        offset = chunk.nextOffset
      }
      expect(restored).toBe(content)
      expect((await SessionPlan.get(session.id)).revision).toBe(1)
      expect(
        (
          await Server.App().request(
            `/session/${session.id}/plan/chunk?offset=${content.length + 1}&directory=${encodeURIComponent(tmp.path)}`,
          )
        ).status,
      ).toBe(400)
    },
  })
})

test("a simplification preserves ordered differences and changes nothing until explicit adoption", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await SessionPlan.save({ sessionID: session.id, content: "A\nB\nA\n", source: "human", expectedRevision: 0 })
      const request = (suffix: string, body: unknown) =>
        Server.App().request(`/session/${session.id}/plan/${suffix}?directory=${encodeURIComponent(tmp.path)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      const response = await request("candidate", { content: "B\nA\n", expectedRevision: 1 })
      expect(response.status).toBe(200)
      const candidate = await response.json()
      expect(candidate.changes).toContainEqual({ type: "delete", text: "A\n" })
      expect(
        candidate.changes
          .filter((change: { type: string }) => change.type !== "insert")
          .map((change: { text: string }) => change.text)
          .join(""),
      ).toBe("A\nB\nA\n")
      expect((await SessionPlan.get(session.id)).content).toBe("A\nB\nA\n")
      expect((await request("adopt", { candidateID: candidate.id })).status).toBe(200)
      expect(await SessionPlan.get(session.id)).toMatchObject({ content: "B\nA\n", revision: 2, source: "human" })
      expect((await SessionPlan.get(session.id)).execution).toBeUndefined()
    },
  })
})
