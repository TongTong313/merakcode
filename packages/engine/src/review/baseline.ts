import { Database } from "../storage/db"

/**
 * Review baselines of a conversation: a file's content when the user last accepted it in review. A baseline holds
 * undefined when the file did not exist then.
 */
export namespace ReviewBaseline {
  type Content = Buffer | undefined

  const buffer = (data: Uint8Array | null) =>
    data ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : undefined

  export function all(sessionID: string) {
    const rows = Database.query("SELECT path, data FROM review_baseline WHERE session_id = ?").all(sessionID) as {
      path: string
      data: Uint8Array | null
    }[]
    return new Map(rows.map((row) => [row.path, buffer(row.data)]))
  }

  /** The baseline of one file; undefined when there is none */
  export function get(sessionID: string, file: string) {
    const row = Database.query("SELECT data FROM review_baseline WHERE session_id = ? AND path = ?").get(
      sessionID,
      file,
    ) as { data: Uint8Array | null } | undefined
    return row && { content: buffer(row.data) }
  }

  export function put(sessionID: string, file: string, content: Content) {
    Database.query(
      `INSERT INTO review_baseline (session_id, path, data) VALUES (?, ?, ?)
       ON CONFLICT (session_id, path) DO UPDATE SET data = excluded.data`,
    ).run(sessionID, file, content ?? null)
  }

  export function remove(sessionID: string, file: string) {
    Database.query("DELETE FROM review_baseline WHERE session_id = ? AND path = ?").run(sessionID, file)
  }

  export function drop(sessionID: string) {
    Database.query("DELETE FROM review_baseline WHERE session_id = ?").run(sessionID)
  }
}
