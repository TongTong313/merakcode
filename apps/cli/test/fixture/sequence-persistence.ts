import { isDeepStrictEqual } from "node:util"
import { z } from "zod"

const record = z.record(z.string(), z.unknown())
const entity = record.and(z.object({ id: z.string() }))
const observed = z.array(z.object({ info: entity, parts: z.array(entity) }))

/** Replay the documented JSONL contract without consulting the live API cache. */
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
    if (line.type === "delta") {
      const part = parts.get(String(line.partID))
      if (!part || line.field !== "text" || typeof line.delta !== "string")
        throw new Error("I1_ORACLE: invalid persisted text delta")
      part.text = String(part.text ?? "") + line.delta
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
