import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * Persistent storage for the renderer, replacing localStorage. Windows load from the local backend, so the origin
 * changes when the backend moves to a new port and localStorage would be lost. Each bucket is a JSON file in the app
 * data directory.
 */
export class Storage {
  private cache = new Map<string, Record<string, string>>()

  constructor(private dir: string) {}

  /** Bucket names are reduced to safe file name characters so writes cannot escape the directory */
  private file(bucket: string) {
    const safe = bucket.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "") || "default.dat"
    return path.join(this.dir, `${safe}.json`)
  }

  private load(bucket: string) {
    const cached = this.cache.get(bucket)
    if (cached) return cached
    const data = (() => {
      try {
        const parsed = JSON.parse(readFileSync(this.file(bucket), "utf8"))
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
      } catch {
        return {}
      }
    })()
    this.cache.set(bucket, data)
    return data
  }

  private save(bucket: string) {
    mkdirSync(this.dir, { recursive: true })
    const target = this.file(bucket)
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(this.load(bucket)))
    renameSync(temp, target)
  }

  get(bucket: string, key: string) {
    return this.load(bucket)[key] ?? null
  }

  set(bucket: string, key: string, value: string) {
    this.load(bucket)[key] = value
    this.save(bucket)
  }

  remove(bucket: string, key: string) {
    const data = this.load(bucket)
    if (!(key in data)) return
    delete data[key]
    this.save(bucket)
  }
}
