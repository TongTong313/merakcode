import { NamedError } from "@merakcode/util/error"
import z from "zod"
import { Database } from "./db"

/**
 * Small JSON records addressed by a key path such as ["todo", sessionID], kept in the record table. Sessions and
 * conversation content have their own tables (SessionStore, Transcript).
 */
export namespace Storage {
  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  const join = (key: string[]) => key.join("/")

  // Keys below a prefix sort between "prefix/" and "prefix0": "0" is the character after "/"
  const range = (prefix: string[]) => [join(prefix) + "/", join(prefix) + "0"] as const

  function get<T>(key: string[]) {
    const row = Database.query("SELECT data FROM record WHERE key = ?").get(join(key)) as { data: string } | undefined
    if (!row) throw new NotFoundError({ message: `Resource not found: ${join(key)}` })
    return JSON.parse(row.data) as T
  }

  function has(key: string[]) {
    return Database.query("SELECT 1 FROM record WHERE key = ?").get(join(key)) !== undefined
  }

  function put(key: string[], content: unknown) {
    Database.query(
      "INSERT INTO record (key, data) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data",
    ).run(join(key), JSON.stringify(content))
  }

  export async function read<T>(key: string[]) {
    return get<T>(key)
  }

  export async function write<T>(key: string[], content: T) {
    put(key, content)
  }

  /** fn edits the stored value in place; read and write run in one transaction. initial stands in for a missing key */
  export async function update<T>(key: string[], fn: (draft: T) => void, initial?: () => T) {
    return Database.transaction(() => {
      const draft = initial && !has(key) ? initial() : get<T>(key)
      fn(draft)
      put(key, draft)
      return draft
    })
  }

  export async function remove(key: string[]) {
    Database.query("DELETE FROM record WHERE key = ?").run(join(key))
  }

  export async function removePrefix(prefix: string[]) {
    Database.query("DELETE FROM record WHERE key >= ? AND key < ?").run(...range(prefix))
  }

  /** Keys below the prefix, sorted */
  export async function list(prefix: string[]) {
    const rows = Database.query("SELECT key FROM record WHERE key >= ? AND key < ? ORDER BY key").all(
      ...range(prefix),
    ) as { key: string }[]
    return rows.map((row) => row.key.split("/"))
  }
}
