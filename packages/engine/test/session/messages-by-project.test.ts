import { expect, test } from "vitest"
import { Session } from "@merakcode/engine/session/index"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"

test("read messages of a session from another project when its project ID is provided", async () => {
  await using first = await tmpdir({ git: true })
  await using second = await tmpdir({ git: true })
  const session = await Instance.provide({ directory: first.path, fn: () => Session.create({}) })

  await Instance.provide({
    directory: second.path,
    fn: async () => {
      expect(Instance.project.id).not.toBe(session.projectID)
      await expect(Session.messages({ sessionID: session.id })).rejects.toThrow()
      expect(await Session.messages({ sessionID: session.id, projectID: session.projectID })).toEqual([])
    },
  })
})
