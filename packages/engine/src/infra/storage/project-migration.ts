import { Filesystem } from "@merakcode/util/filesystem"
import { Log } from "@merakcode/log/logger"
import { Database } from "./db"
import { Storage } from "./storage"

/** Reassigns the stored history partition when a formerly non-Git directory gains a project identity. */
export async function migrateSessionsFromGlobal(projectID: string, worktree: string) {
  if (!(await Storage.read(["project", "global"]).catch(() => undefined))) return
  const rows = Database.query("SELECT id, data FROM session WHERE project_id = ? ORDER BY id").all("global") as {
    id: string
    data: string
  }[]
  for (const row of rows) {
    const record = (() => {
      try {
        const value = JSON.parse(row.data)
        return value && typeof value === "object" && value.id === row.id ? value : undefined
      } catch {
        return undefined
      }
    })()
    if (!record) continue
    if (record.directory && Filesystem.normalize(record.directory) !== Filesystem.normalize(worktree)) continue
    Log.Default.info("migrating session", { sessionID: row.id, from: "global", to: projectID })
    Database.query(
      "UPDATE session SET project_id = ?, parent_id = ?, title = ?, updated = ?, data = ? WHERE id = ?",
    ).run(
      projectID,
      record.parentID ?? null,
      record.title,
      record.time.updated,
      JSON.stringify({ ...record, projectID }),
      row.id,
    )
  }
}
