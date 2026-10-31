import { mkdirSync } from "node:fs"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import path from "path"
import { Log } from "@merakcode/log/logger"
import { Global } from "../global"

/**
 * The engine database, data/merakcode.db under the MerakCode root, shared by every engine process on the machine.
 * WAL lets readers run alongside one writer; a writer waits up to BUSY_TIMEOUT_MS for another process to finish.
 * Calls are synchronous and short. Anything that reads and then writes runs in transaction().
 */
export namespace Database {
  const log = Log.create({ service: "storage.db" })
  const BUSY_TIMEOUT_MS = 10_000

  /** Each entry upgrades the schema by one version (PRAGMA user_version). Entries are only ever appended. */
  const MIGRATIONS = [
    `
    -- Small records behind Storage: todo, cron, workflow, notifications, projects and so on. key is the joined key path.
    CREATE TABLE record (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL,
      updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX session_project ON session (project_id, id);
    CREATE INDEX session_parent ON session (parent_id);
    CREATE INDEX session_updated ON session (updated);

    -- written: when the row was last written, the session activity seen by retention
    CREATE TABLE message (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      written INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );

    -- A part can be written before its message
    CREATE TABLE part (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      written INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );
    CREATE INDEX part_message ON part (session_id, message_id, id);

    -- Conversation text for search, keyed by the part rowid and kept in step by the triggers below: text parts the
    -- user or the model wrote, not synthetic ones (attached file contents and the like). The trigram tokenizer matches
    -- substrings in any language, including Chinese
    CREATE VIRTUAL TABLE part_text USING fts5 (text, tokenize = 'trigram');
    CREATE TRIGGER part_text_insert AFTER INSERT ON part
    WHEN json_extract(new.data, '$.type') = 'text' AND NOT coalesce(json_extract(new.data, '$.synthetic'), 0)
    BEGIN
      INSERT INTO part_text (rowid, text) VALUES (new.rowid, json_extract(new.data, '$.text'));
    END;
    CREATE TRIGGER part_text_update AFTER UPDATE ON part
    BEGIN
      DELETE FROM part_text WHERE rowid = old.rowid;
      INSERT INTO part_text (rowid, text) SELECT new.rowid, json_extract(new.data, '$.text')
      WHERE json_extract(new.data, '$.type') = 'text' AND NOT coalesce(json_extract(new.data, '$.synthetic'), 0);
    END;
    CREATE TRIGGER part_text_delete AFTER DELETE ON part
    BEGIN
      DELETE FROM part_text WHERE rowid = old.rowid;
    END;

    -- Review baselines: a file's content when the user last accepted it in review; data is NULL when it did not exist
    CREATE TABLE review_baseline (
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      data BLOB,
      PRIMARY KEY (session_id, path)
    );
    `,
  ]

  let db: DatabaseSync | undefined
  const statements = new Map<string, StatementSync>()

  export function file() {
    return path.join(Global.Path.data, "merakcode.db")
  }

  /** SQLITE_BUSY, including extended codes such as SQLITE_BUSY_RECOVERY */
  const busy = (error: unknown) => ((error as { errcode?: number }).errcode ?? 0) % 256 === 5

  function open() {
    mkdirSync(Global.Path.data, { recursive: true })
    // Switching to WAL while another process creates or recovers the database fails as busy at once, without the busy
    // timeout, so the whole opening sequence is retried until the same deadline
    const deadline = Date.now() + BUSY_TIMEOUT_MS
    for (;;) {
      const next = new DatabaseSync(file(), { timeout: BUSY_TIMEOUT_MS })
      try {
        next.exec("PRAGMA journal_mode = WAL")
        next.exec("PRAGMA synchronous = NORMAL")
        migrate(next)
        return next
      } catch (error) {
        next.close()
        if (!busy(error) || Date.now() >= deadline) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      }
    }
  }

  function migrate(target: DatabaseSync) {
    const version = () => target.prepare("PRAGMA user_version").get()!.user_version as number
    if (version() >= MIGRATIONS.length) return
    target.exec("BEGIN IMMEDIATE")
    try {
      // Another process may have migrated while this one waited for the write lock
      for (let index = version(); index < MIGRATIONS.length; index++) {
        target.exec(MIGRATIONS[index]!)
        target.exec(`PRAGMA user_version = ${index + 1}`)
        log.info("migrated", { version: index + 1 })
      }
      target.exec("COMMIT")
    } catch (error) {
      target.exec("ROLLBACK")
      throw error
    }
  }

  function use() {
    db ??= open()
    return db
  }

  /** A prepared statement, cached by its SQL */
  export function query(sql: string) {
    const found = statements.get(sql)
    if (found) return found
    const statement = use().prepare(sql)
    statements.set(sql, statement)
    return statement
  }

  /**
   * Runs fn in one write transaction. BEGIN IMMEDIATE takes the write lock up front, so a read-modify-write cannot
   * lose another process's change. fn must be synchronous; a nested call joins the outer transaction.
   */
  export function transaction<T>(fn: () => T): T {
    const current = use()
    if (current.isTransaction) return fn()
    current.exec("BEGIN IMMEDIATE")
    try {
      const result = fn()
      current.exec("COMMIT")
      return result
    } catch (error) {
      if (current.isTransaction) current.exec("ROLLBACK")
      throw error
    }
  }

  /** Closes the connection; the next call opens it again */
  export function close() {
    statements.clear()
    db?.close()
    db = undefined
  }
}
