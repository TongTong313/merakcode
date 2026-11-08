import Database from "better-sqlite3"
import { z } from "zod"
import {
  EventEventSchema,
  StoreQuerySchema,
  StoreDocSchema,
  StoreDocMetaSchema,
  type EventEvent,
  type StoreQuery,
  type StoreDoc,
  type StoreDocMeta,
} from "./protocol.gen"
import { storeSchema } from "./store-schema.gen"

import { StoreError } from "./store-error"
export { StoreError } from "./store-error"

const eventRow = z.object({
  id: z.string(),
  stream: z.string(),
  seq: z.number().int(),
  time: z.string(),
  type: z.string(),
  grp: z.string().nullable(),
  task: z.string().nullable(),
  session: z.string().nullable(),
  turn: z.string().nullable(),
  actor_kind: z.string(),
  actor_id: z.string().nullable(),
  cause: z.string().nullable(),
  payload: z.instanceof(Buffer),
})

export class SqliteStore {
  private readonly db: Database.Database

  constructor(filename: string) {
    this.db = new Database(filename, { timeout: 5000 })
    try {
      this.db.pragma("journal_mode = WAL")
      this.db.pragma("synchronous = FULL")
      this.db.exec(storeSchema)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close() {
    this.db.close()
  }

  append(events: EventEvent[]) {
    const input = z.array(EventEventSchema).parse(events)
    this.db
      .transaction(() => {
        for (const event of input) {
          const last = z
            .object({ seq: z.number() })
            .parse(
              this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE stream = ?").get(event.stream),
            )
          if (
            !event.id ||
            !event.stream ||
            event.seq !== last.seq + 1 ||
            this.db.prepare("SELECT id FROM events WHERE id = ?").get(event.id)
          )
            throw new StoreError("sequence")
          this.db
            .prepare(
              "INSERT INTO events (id, stream, seq, time, type, grp, task, session, turn, actor_kind, actor_id, cause, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              event.id,
              event.stream,
              event.seq,
              timestamp(event.time),
              event.type,
              event.scope.group ?? null,
              event.scope.task ?? null,
              event.scope.session ?? null,
              event.scope.turn ?? null,
              event.actor.kind,
              event.actor.id ?? null,
              event.cause ?? null,
              Buffer.from(JSON.stringify(event.payload)),
            )
        }
      })
      .immediate()
  }

  read(stream: string, from: number, limit: number): EventEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE stream = ? AND seq >= ? ORDER BY seq LIMIT ?")
      .all(stream, from, limit > 0 ? limit : -1)
      .map(decodeEvent)
  }

  find(query: StoreQuery): EventEvent[] {
    const q = StoreQuerySchema.parse(query)
    const where = ["1 = 1"]
    const args: (string | number)[] = []
    for (const [column, value] of [
      ["grp", q.scope?.group],
      ["task", q.scope?.task],
      ["session", q.scope?.session],
      ["turn", q.scope?.turn],
    ]) {
      if (value) {
        where.push(`${column} = ?`)
        args.push(value)
      }
    }
    if (q.types?.length) {
      where.push(`type IN (${q.types.map(() => "?").join(",")})`)
      args.push(...q.types)
    }
    if (q.after && q.after !== "0001-01-01T00:00:00Z") {
      where.push("time > ?")
      args.push(timestamp(q.after))
    }
    if (q.before && q.before !== "0001-01-01T00:00:00Z") {
      where.push("time < ?")
      args.push(timestamp(q.before))
    }
    args.push(q.limit && q.limit > 0 ? q.limit : -1)
    return this.db
      .prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY time, stream, seq LIMIT ?`)
      .all(...args)
      .map(decodeEvent)
  }

  get(id: string): EventEvent {
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id)
    if (!row) throw new StoreError("not-found")
    return decodeEvent(row)
  }

  put(input: StoreDoc) {
    const doc = StoreDocSchema.parse(input)
    const body = Buffer.from(doc.body === null ? "" : z.base64().parse(doc.body), "base64")
    const meta = JSON.stringify(doc.meta ?? null)
    const result =
      doc.rev === 0
        ? this.db
            .prepare("INSERT INTO docs (kind,key,rev,body,meta) VALUES (?,?,1,?,?) ON CONFLICT(kind,key) DO NOTHING")
            .run(doc.kind, doc.key, body, meta)
        : this.db
            .prepare("UPDATE docs SET rev = rev + 1, body = ?, meta = ? WHERE kind = ? AND key = ? AND rev = ?")
            .run(body, meta, doc.kind, doc.key, doc.rev)
    if (result.changes === 0) throw new StoreError("conflict")
  }

  fetch(kind: string, key: string): StoreDoc {
    const input = this.db.prepare("SELECT rev, body, meta FROM docs WHERE kind = ? AND key = ?").get(kind, key)
    if (!input) throw new StoreError("not-found")
    const row = z.object({ rev: z.number(), body: z.instanceof(Buffer), meta: z.string().nullable() }).parse(input)
    const meta: unknown = JSON.parse(row.meta ?? "null")
    return StoreDocSchema.parse({
      kind,
      key,
      rev: row.rev,
      body: row.body.toString("base64"),
      ...(meta === null ? {} : { meta }),
    })
  }

  list(kind: string, prefix: string): StoreDocMeta[] {
    return this.db
      .prepare("SELECT key,rev,meta FROM docs WHERE kind = ? AND substr(key,1,length(?)) = ? ORDER BY key")
      .all(kind, prefix, prefix)
      .map((input) => {
        const row = z.object({ key: z.string(), rev: z.number(), meta: z.string().nullable() }).parse(input)
        const meta: unknown = JSON.parse(row.meta ?? "null")
        return StoreDocMetaSchema.parse({ kind, key: row.key, rev: row.rev, ...(meta === null ? {} : { meta }) })
      })
  }
}

function decodeEvent(input: unknown): EventEvent {
  const row = eventRow.parse(input)
  return {
    id: row.id,
    stream: row.stream,
    seq: row.seq,
    time: row.time.replace(/\.(\d*?)0+Z$/, (_match, fraction: string) => (fraction ? `.${fraction}Z` : "Z")),
    type: row.type,
    scope: {
      ...(row.grp && { group: row.grp }),
      ...(row.task && { task: row.task }),
      ...(row.session && { session: row.session }),
      ...(row.turn && { turn: row.turn }),
    },
    actor: { kind: row.actor_kind, ...(row.actor_id && { id: row.actor_id }) },
    ...(row.cause && { cause: row.cause }),
    payload: JSON.parse(row.payload.toString("utf8")),
  }
}

function timestamp(value: string) {
  z.iso.datetime({ offset: true }).parse(value)
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? ""
  return new Date(value).toISOString().slice(0, 19) + "." + fraction.padEnd(9, "0") + "Z"
}
