import { Project } from "../../infra/project/project"
import { migrateSessionsFromGlobal } from "../../infra/storage/project-migration"
import { Global } from "../../infra/global"

/** Application project creation also adopts history left while the directory had no Git identity. */
export async function discoverProject(directory: string) {
  await Global.initialize()
  const result = await Project.fromDirectory(directory)
  if (result.project.id !== "global") await migrateSessionsFromGlobal(result.project.id, result.project.worktree)
  return result
}
