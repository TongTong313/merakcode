import { failure } from "@merakcode/log"
import { Log } from "@merakcode/log/logger"
import { Database } from "../../infra/storage/db"
import { Message } from "./message"

/**
 * Session content: messages and parts in the message and part tables. Session metadata lives in the session table
 * (SessionStore) and is not handled here.
 *
 * Data is persisted only on state transitions and completion. Streaming deltas and tool progress stay in an in-process
 * in-flight copy that reads from this process can see; it is written together with the message when the message
 * completes (including a user stop). A process crash loses that in-flight part.
 */
export namespace Transcript {
  const log = Log.create({ service: "session.transcript" })

  export type Line =
    | { type: "message"; info: Message.Info }
    | { type: "part"; part: Message.Part }
    | { type: "remove"; messageID: string; partID?: string }

  const SWEEP_DELAY_MS = 30_000

  // In-flight copies: partID -> latest unpersisted Part (streaming text, later updates within the same tool state)
  const inflight = new Map<string, Message.Part>()
  // Tool status at the last write, used to detect a transition to a new state
  const persisted = new Map<string, { sessionID: string; messageID: string; status: string }>()
  // A late progress callback must not put a cancelled or completed tool back into running state.
  const terminalParts = new Set<string>()
  let scheduled = false

  function putMessage(sessionID: string, info: Message.Info) {
    Database.query(
      `INSERT INTO message (session_id, id, written, data) VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id, id) DO UPDATE SET written = excluded.written, data = excluded.data`,
    ).run(sessionID, info.id, Date.now(), JSON.stringify(info))
  }

  function putPart(sessionID: string, part: Message.Part) {
    Database.query(
      `INSERT INTO part (session_id, id, message_id, written, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (session_id, id) DO UPDATE SET message_id = excluded.message_id, written = excluded.written,
         data = excluded.data`,
    ).run(sessionID, part.id, part.messageID, Date.now(), JSON.stringify(part))
  }

  function apply(sessionID: string, line: Line) {
    if (line.type === "message") return putMessage(sessionID, line.info)
    if (line.type === "part") return putPart(sessionID, line.part)
    if (line.partID) {
      Database.query("DELETE FROM part WHERE session_id = ? AND message_id = ? AND id = ?").run(
        sessionID,
        line.messageID,
        line.partID,
      )
      return
    }
    Database.query("DELETE FROM part WHERE session_id = ? AND message_id = ?").run(sessionID, line.messageID)
    Database.query("DELETE FROM message WHERE session_id = ? AND id = ?").run(sessionID, line.messageID)
  }

  export async function append(sessionID: string, lines: Line[]) {
    Database.transaction(() => {
      for (const line of lines) apply(sessionID, line)
    })
  }

  function decode<T>(sessionID: string, data: string): T | undefined {
    try {
      return JSON.parse(data) as T
    } catch (error) {
      log.warn("record skipped", { sessionID, ...failure(error) })
      return undefined
    }
  }

  function info(sessionID: string, messageID: string) {
    const row = Database.query("SELECT data FROM message WHERE session_id = ? AND id = ?").get(sessionID, messageID) as
      { data: string } | undefined
    return row && decode<Message.Info>(sessionID, row.data)
  }

  /**
   * Read-modify-write in one transaction: computes the next version from the stored message and writes it. When an
   * assistant message completes (`time.completed` set), its in-flight parts are written in the same transaction; this
   * is what persists a partial reply when the user stops.
   */
  export async function update(
    sessionID: string,
    messageID: string,
    change: (prev: Message.Info | undefined) => Message.Info,
  ) {
    return Database.transaction(() => {
      const next = change(info(sessionID, messageID))
      if (next.role === "assistant" && next.time.completed !== undefined)
        for (const part of settle(messageID)) putPart(sessionID, part)
      putMessage(sessionID, next)
      return next
    })
  }

  // Takes and clears a message's in-flight copies and tool states, so parts aborted mid-stream do not stay in memory
  function settle(messageID: string) {
    const items = [...inflight.values()].filter((item) => item.messageID === messageID)
    for (const item of items) inflight.delete(item.id)
    for (const [id, entry] of persisted) if (entry.messageID === messageID) persisted.delete(id)
    return items
  }

  /**
   * Part persistence: the first update in a new state and other updates are written; streaming text deltas and later
   * updates within the same tool state (input streaming, running progress) only update the in-flight copy. Callers
   * still publish events to clients as usual.
   */
  export async function part(item: Message.Part, delta?: string) {
    if (item.type === "tool") {
      const status = item.state.status
      if ((status === "pending" || status === "running") && terminalParts.has(item.id)) return false
      if (status === "completed" || status === "error") {
        terminalParts.add(item.id)
        if (terminalParts.size > 4096) terminalParts.delete(terminalParts.values().next().value!)
      }
    }
    if (hold(item, delta)) {
      inflight.set(item.id, item)
      return true
    }
    inflight.delete(item.id)
    putPart(item.sessionID, item)
    return true
  }

  function hold(item: Message.Part, delta?: string) {
    if (delta !== undefined && "text" in item) return true
    if (item.type !== "tool") return false
    const status = item.state.status
    if (status !== "pending" && status !== "running") {
      persisted.delete(item.id)
      return false
    }
    if (persisted.get(item.id)?.status === status) return true
    persisted.set(item.id, { sessionID: item.sessionID, messageID: item.messageID, status })
    return false
  }

  export async function remove(sessionID: string, messageID: string, partID?: string) {
    if (partID) inflight.delete(partID)
    if (!partID) settle(messageID)
    await append(sessionID, [{ type: "remove", messageID, ...(partID ? { partID } : {}) }])
  }

  /** Deletes session content */
  export async function drop(sessionID: string) {
    Database.transaction(() => {
      Database.query("DELETE FROM part WHERE session_id = ?").run(sessionID)
      Database.query("DELETE FROM message WHERE session_id = ?").run(sessionID)
    })
    for (const [id, item] of inflight) if (item.sessionID === sessionID) inflight.delete(id)
    for (const [id, entry] of persisted) if (entry.sessionID === sessionID) persisted.delete(id)
  }

  /** Atomically writes the whole content only if the session has none yet; returns false if it already has some. */
  export async function create(sessionID: string, lines: Line[]) {
    return Database.transaction(() => {
      const exists = Database.query(
        "SELECT 1 FROM message WHERE session_id = ? UNION ALL SELECT 1 FROM part WHERE session_id = ? LIMIT 1",
      ).get(sessionID, sessionID)
      if (exists) return false
      for (const line of lines) apply(sessionID, line)
      return true
    })
  }

  /** When the session content was last written, 0 when it has none */
  export function written(sessionID: string) {
    const row = Database.query(
      `SELECT max(coalesce((SELECT max(written) FROM message WHERE session_id = ?), 0),
                  coalesce((SELECT max(written) FROM part WHERE session_id = ?), 0)) AS time`,
    ).get(sessionID, sessionID) as { time: number }
    return row.time
  }

  const byID = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

  // In-flight copies override stored parts: at the end of a turn the processor reads parts back from storage and must
  // see the latest unpersisted content
  function partsOf(sessionID: string, messageID: string) {
    const rows = Database.query("SELECT data FROM part WHERE session_id = ? AND message_id = ? ORDER BY id").all(
      sessionID,
      messageID,
    ) as { data: string }[]
    const parts = new Map<string, Message.Part>()
    for (const row of rows) {
      const item = decode<Message.Part>(sessionID, row.data)
      if (item) parts.set(item.id, item)
    }
    for (const item of inflight.values())
      if (item.sessionID === sessionID && item.messageID === messageID) parts.set(item.id, structuredClone(item))
    return [...parts.values()].toSorted(byID).map(Message.legacyPart)
  }

  function full(sessionID: string, message: Message.Info): Message.FullMsg {
    return { info: Message.legacy(message), parts: partsOf(sessionID, message.id) }
  }

  /** Yields messages by descending ID (newest first); parts are read lazily, so breaking early skips the rest */
  export async function* reverse(sessionID: string) {
    const rows = Database.query("SELECT data FROM message WHERE session_id = ? ORDER BY id DESC").all(sessionID) as {
      data: string
    }[]
    for (const row of rows) {
      const message = decode<Message.Info>(sessionID, row.data)
      if (message) yield full(sessionID, message)
    }
  }

  export async function message(sessionID: string, messageID: string) {
    const found = info(sessionID, messageID)
    return found && full(sessionID, found)
  }

  /** All parts of a message; the message itself does not need to be persisted yet */
  export async function parts(sessionID: string, messageID: string) {
    return partsOf(sessionID, messageID)
  }

  /** Background cleanup after startup, delayed so it does not block startup */
  export function schedule() {
    if (scheduled) return
    scheduled = true
    setTimeout(() => void sweep(), SWEEP_DELAY_MS).unref?.()
  }

  // Optional retention in days; history is kept forever by default
  export async function sweep() {
    const { Config } = await import("@merakcode/engine/agent/settings/index")
    const days = (await Config.global().catch(() => undefined))?.storage?.retention_days
    if (!days) return
    const { Session } = await import("./index")
    const count = await Session.expire(Date.now() - days * 86_400_000).catch((error) => {
      log.warn("retention failed", { ...failure(error) })
      return 0
    })
    log.info("retention completed", { days, count })
  }
}
