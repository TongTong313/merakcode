import path from "path"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { MemoryPath } from "../memory/path"

/**
 * Paths for SessionMemory (per-session notes).
 *
 * Notes are scoped by sessionID (one session's lifetime), unlike persistent memory, which is scoped by projectKey
 * across sessions. The project segment reuses {@link MemoryPath.projectKey} so notes from the same project share a
 * project directory.
 */
export namespace SessionMemoryPath {
  /** Project root of the current Instance: the worktree, or the directory when the worktree is the filesystem root */
  function root() {
    return Instance.worktree === "/" ? Instance.directory : Instance.worktree
  }

  /** Notes directory of a session: {data}/session-memory/projects/{projectKey}/{sessionID}/ */
  export function directory(sessionID: string) {
    return (
      path.join(Global.Path.data, "session-memory", "projects", MemoryPath.projectKey(root()), sessionID) + path.sep
    )
  }

  /** Notes file of a session: directory + summary.md */
  export function file(sessionID: string) {
    return path.join(directory(sessionID), "summary.md")
  }
}
