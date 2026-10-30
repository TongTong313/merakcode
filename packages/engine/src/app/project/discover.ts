import { Project } from "../../infra/project/project"
import { migrateSessionsFromGlobal } from "../../infra/storage/project-migration"

/** Application project creation also adopts history left while the directory had no Git identity. */
export async function discoverProject(directory: string) {
  const result = await Project.fromDirectory(directory)
  if (result.project.id !== "global") await migrateSessionsFromGlobal(result.project.id, result.project.worktree)
  return result
}
