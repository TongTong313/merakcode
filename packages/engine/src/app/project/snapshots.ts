import { Snapshot } from "../../infra/project/snapshot"
import { SessionStore } from "../../agent/session/store"
import { SessionUndoRedo } from "../../agent/loop/undo-redo"
import { Config } from "../config/files/config"

/** Session expiry policy is decided before the file backup mechanism removes a directory. */
export async function cleanupSnapshots() {
  await Snapshot.cleanup({
    enabled: (await Config.get()).snapshot !== false,
    async remove(sessionID) {
      const session = (() => {
        try {
          return SessionStore.find(sessionID)
        } catch {
          return null
        }
      })()
      if (session === null) return false
      if (!session) return true
      const updated = session.time?.updated ?? session.time?.created ?? 0
      if (Date.now() - updated <= 7 * 24 * 60 * 60 * 1000) return false
      if (session.undoRedo?.stack?.length) await SessionUndoRedo.discard({ sessionID, projectID: session.projectID })
      return true
    },
  })
}
