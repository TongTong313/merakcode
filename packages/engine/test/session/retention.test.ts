import { expect, test } from "vitest"
import fs from "fs/promises"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { Transcript } from "@merakcode/engine/session/transcript"
import { Storage } from "@merakcode/engine/storage/storage"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

Log.init({ print: false })

/** Optional retention period: off by default; when on, only sessions whose whole tree has expired are deleted. */

const DAY = 86_400_000

async function age(session: Session.Info, time: number) {
  await Storage.update<Session.Info>(["session", session.projectID, session.id], (draft) => {
    draft.time.updated = time
  })
}

async function say(sessionID: string) {
  await Session.updateInfo({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created: Date.now() },
  })
}

test("expired session trees are deleted whole; trees with an active child or fresh content are kept", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const old = Date.now() - 40 * DAY
      const cutoff = Date.now() - 30 * DAY

      // Whole tree expired: deleted.
      const stale = await Session.create({})
      const staleChild = await Session.create({ parentID: stale.id })
      await say(stale.id)
      await age(stale, old)
      await age(staleChild, old)
      await fs.utimes(Transcript.file(stale.id), new Date(old), new Date(old))

      // Root expired but the child was used recently: the whole tree is kept.
      const parent = await Session.create({})
      await Session.create({ parentID: parent.id })
      await age(parent, old)

      // Old time.updated but the transcript was just written: kept.
      const busy = await Session.create({})
      await age(busy, old)
      await say(busy.id)

      // Other files in the same test process may leave old sessions behind, so only this test's trees are asserted.
      expect(await Session.expire(cutoff)).toBeGreaterThanOrEqual(2)
      await expect(Session.get(stale.id)).rejects.toBeInstanceOf(Storage.NotFoundError)
      await expect(Session.get(staleChild.id)).rejects.toBeInstanceOf(Storage.NotFoundError)
      expect(await Filesystem.isFile(Transcript.file(stale.id))).toBe(false)
      expect((await Session.get(parent.id)).id).toBe(parent.id)
      expect((await Session.get(busy.id)).id).toBe(busy.id)
    },
  })
})
