import path from "path"
import { MemoryAccess } from "../memory/access"
import { SessionMemoryPath } from "../memory/session-memory/path"
import { isPlanDocBypass, isUnderPlansDataDir, type PlanDocAuthor } from "./plan-doc"

/**
 * The product's own files (in the data directory, not the workspace) need no approval:
 * - memory files: any agent may read them; only .md files and the index under memory type directories may be written
 * - plan files: any agent may read them; they may be written in plan mode (see isPlanDocBypass)
 * - session notes: only the session-memory agent may read and write the notes of its own session
 */
export async function isProjectFileBypass(input: PlanDocAuthor & { filePath: string; access: "read" | "write" }) {
  if (await isPlanDocBypass(input, input.filePath)) return true
  if (await isSessionNotes(input.agent, input.filePath, input.sessionID)) return true
  if (input.access === "read") return MemoryAccess.isReadablePath(input.filePath) || isUnderPlansDataDir(input.filePath)
  return MemoryAccess.isWritablePath(input.filePath)
}

async function isSessionNotes(agent: string, filePath: string, sessionID?: string) {
  if (agent !== "session-memory" || !sessionID) return false
  // Dynamic import breaks the cycle session → runner → tool/registry → tool/edit → this module
  const { Session } = await import("../session")
  const session = await Session.get(sessionID).catch(() => undefined)
  if (!session?.parentID) return false
  const expected = path.resolve(SessionMemoryPath.file(session.parentID))
  const target = path.resolve(filePath)
  return process.platform === "win32" ? expected.toLowerCase() === target.toLowerCase() : expected === target
}
