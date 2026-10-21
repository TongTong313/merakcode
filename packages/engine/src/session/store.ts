import type { Session } from "."
import { Database } from "../storage/db"

/**
 * Session records in the session table. Session (index.ts) adds validation, events and the rest of the lifecycle.
 * Single reads throw when the stored data is damaged; listings skip damaged rows.
 */
export namespace SessionStore {
  type Info = Session.Info
  type Row = { id: string; data: string }

  function decode(row: Row): Info {
    const info = JSON.parse(row.data)
    if (!info || typeof info !== "object" || info.id !== row.id) throw new SyntaxError("session data does not match")
    return info
  }

  function decodeAll(rows: Row[]) {
    return rows.flatMap((row) => {
      try {
        return [decode(row)]
      } catch {
        return []
      }
    })
  }

  function select(projectID: string, id: string) {
    return Database.query("SELECT id, data FROM session WHERE id = ? AND project_id = ?").get(id, projectID) as
      Row | undefined
  }

  export function get(projectID: string, id: string) {
    const row = select(projectID, id)
    return row && decode(row)
  }

  /** The session in whichever project holds it */
  export function find(id: string) {
    const row = Database.query("SELECT id, data FROM session WHERE id = ?").get(id) as Row | undefined
    return row && decode(row)
  }

  export function put(info: Info) {
    Database.query(
      `INSERT INTO session (id, project_id, parent_id, title, updated, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, parent_id = excluded.parent_id,
         title = excluded.title, updated = excluded.updated, data = excluded.data`,
    ).run(info.id, info.projectID, info.parentID ?? null, info.title, info.time.updated, JSON.stringify(info))
  }

  /** editor changes the stored session in place; undefined when it does not exist */
  export function update(projectID: string, id: string, editor: (draft: Info) => void) {
    return Database.transaction(() => {
      const row = select(projectID, id)
      if (!row) return undefined
      const draft = decode(row)
      editor(draft)
      put(draft)
      return draft
    })
  }

  export function remove(id: string) {
    Database.query("DELETE FROM session WHERE id = ?").run(id)
  }

  /** Sessions of a project, newest first (session IDs sort in descending time) */
  export function list(projectID: string) {
    return decodeAll(
      Database.query("SELECT id, data FROM session WHERE project_id = ? ORDER BY id").all(projectID) as Row[],
    )
  }

  export function children(parentID: string) {
    return decodeAll(
      Database.query("SELECT id, data FROM session WHERE parent_id = ? ORDER BY id").all(parentID) as Row[],
    )
  }

  /** Sessions of every project */
  export function all() {
    return decodeAll(Database.query("SELECT id, data FROM session").all() as Row[])
  }

  export type Found = { session: Info; match?: { messageID: string; text: string } }

  /**
   * Sessions whose title or conversation text (what the user and the model wrote) contains term, case-insensitive,
   * most recently updated first. match is the latest text that contains it. Without a term every session matches.
   */
  export function search(input: { term?: string; projectID?: string; roots?: boolean }): Found[] {
    const filter = "($project IS NULL OR s.project_id = $project) AND ($roots = 0 OR s.parent_id IS NULL)"
    const scope = { project: input.projectID ?? null, roots: input.roots ? 1 : 0 }
    if (!input.term) {
      const rows = Database.query(`SELECT id, data FROM session s WHERE ${filter} ORDER BY updated DESC`).all(
        scope,
      ) as Row[]
      return decodeAll(rows).map((session) => ({ session }))
    }
    // ESCAPE keeps the trigram index from being used, so it is only added when the term needs it
    const escaped = /[\\%_]/.test(input.term)
    const like = escaped ? "LIKE $pattern ESCAPE '\\'" : "LIKE $pattern"
    const pattern = "%" + (escaped ? input.term.replace(/[\\%_]/g, (char) => "\\" + char) : input.term) + "%"
    const rows = Database.query(
      `SELECT s.id, s.data, m.message_id, m.text FROM session s
       LEFT JOIN (
         SELECT p.session_id, p.message_id, t.text,
           row_number() OVER (PARTITION BY p.session_id ORDER BY p.id DESC) AS n
         FROM part_text t JOIN part p ON p.rowid = t.rowid
         WHERE t.text ${like}
       ) m ON m.session_id = s.id AND m.n = 1
       WHERE ${filter} AND (m.session_id IS NOT NULL OR s.title ${like})
       ORDER BY s.updated DESC`,
    ).all({ ...scope, pattern }) as (Row & { message_id: string | null; text: string | null })[]
    return rows.flatMap((row) => {
      const [session] = decodeAll([row])
      if (!session) return []
      if (row.message_id === null || row.text === null) return [{ session }]
      return [{ session, match: { messageID: row.message_id, text: row.text } }]
    })
  }
}
