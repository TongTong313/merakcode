import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"

const record = z.record(z.string(), z.unknown())
const entity = record.and(z.object({ id: z.string() }))
const observed = z.array(z.object({ info: entity, parts: z.array(entity) }))

/**
 * A session's stored messages and parts, read straight from the kit's database (`data/merakcode.db` under the
 * MerakCode root) as message and part records.
 */
export function stored(root: string, sessionID: string): Record<string, any>[] {
  using db = new DatabaseSync(join(root, "data", "merakcode.db"), { timeout: 10_000 })
  const rows = (table: string) =>
    (db.prepare(`SELECT data FROM ${table} WHERE session_id = ? ORDER BY id`).all(sessionID) as { data: string }[]).map(
      (row) => JSON.parse(row.data),
    )
  return [
    ...rows("message").map((info) => ({ type: "message", info })),
    ...rows("part").map((part) => ({ type: "part", part })),
  ]
}

/** Apply stored records (plus any test edits) without consulting the live API cache. */
export function assertPersisted(current: unknown, lines: unknown[]) {
  const messages = new Map<string, Record<string, unknown>>()
  const parts = new Map<string, Record<string, unknown>>()
  for (const raw of lines) {
    const line = record.parse(raw)
    if (line.type === "message") {
      const info = entity.parse(line.info)
      messages.set(info.id, info)
    }
    if (line.type === "part") {
      const part = entity.parse(line.part)
      parts.set(part.id, part)
    }
    if (line.type === "remove") {
      if (typeof line.partID === "string") parts.delete(line.partID)
      else {
        messages.delete(String(line.messageID))
        for (const [id, part] of parts) if (part.messageID === line.messageID) parts.delete(id)
      }
    }
  }
  for (const item of observed.parse(current)) {
    const saved = messages.get(item.info.id)
    // API schema projections may omit other message fields. Compare every
    // observed ownership, error and completion field, not merely its presence.
    if (
      !saved ||
      !Object.entries(item.info).every(([key, value]) =>
        key === "time"
          ? Object.entries(record.parse(value)).every(([name, time]) =>
              isDeepStrictEqual(record.parse(saved.time)[name], time),
            )
          : isDeepStrictEqual(saved[key], value),
      )
    )
      throw new Error("I1_ORACLE: persisted message content mismatch")
    for (const part of item.parts) {
      // Parts preserve unknown contract fields: includes text/time and actual
      // tool input, output, error, call identity and owner, with no body logging.
      if (!isDeepStrictEqual(parts.get(part.id), part)) throw new Error("I1_ORACLE: persisted part content mismatch")
    }
  }
}
