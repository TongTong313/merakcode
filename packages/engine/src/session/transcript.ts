import fs from "fs/promises"
import { constants } from "fs"
import path from "path"
import { failure } from "@merakcode/log"
import { Global } from "../global"
import { Installation } from "../installation"
import { Log } from "@merakcode/log/logger"
import { Message } from "./message"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * Append-only storage for session content: one JSONL file per session, one record per line, where each line is a
 * `Message.Info` or `Part`. Session metadata stays in `session/<projectID>/<id>.json` and is not handled here.
 *
 * Reading replays lines in order and merges by ID; writing only appends and never rewrites existing lines.
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
    // No longer written; kept only so older files can still be read (record types are only ever added)
    | { type: "delta"; messageID: string; partID: string; field: "text"; delta: string }
    | { type: "remove"; messageID: string; partID?: string }

  // time / times: when each record was last written
  type Entry = { info?: Message.Info; time?: number; parts: Map<string, Message.Part>; times: Map<string, number> }
  type Loaded = Entry & { info: Message.Info }
  type State = { ino: number; offset: number; messages: Map<string, Entry> }

  const SWEEP_DELAY_MS = 30_000
  const TEMP_TTL_MS = 3_600_000
  // The replay cache keeps only recently used sessions, so memory in long-lived processes (desktop) does not grow
  // with every session opened
  const CACHE_LIMIT = 32

  const cache = new Map<string, State>()
  const queues = new Map<string, Promise<unknown>>()
  const reads = new Map<string, Promise<unknown>>()
  const guarded = new Set<string>()
  // In-flight copies: partID -> latest unpersisted Part (streaming text, later updates within the same tool state)
  const inflight = new Map<string, Message.Part>()
  // Tool status at the last write, used to detect a transition to a new state
  const persisted = new Map<string, { sessionID: string; messageID: string; status: string }>()
  // A late progress callback must not put a cancelled or completed tool back into running state.
  const terminalParts = new Set<string>()
  const decoder = new TextDecoder()
  let scheduled = false

  export function file(sessionID: string) {
    return path.join(Global.Path.data, "storage", "transcript", sessionID + ".jsonl")
  }

  // Serialize at call time: callers such as the streaming processor keep mutating the same object, and serializing
  // after queueing would put later deltas into this snapshot
  function encode(lines: Line[]) {
    const time = Date.now()
    return lines
      .map(({ type, ...rest }) => JSON.stringify({ type, time, version: Installation.VERSION, ...rest }) + "\n")
      .join("")
  }

  // Writes to one session are serialized in-process so line order matches call order (a delta must follow its
  // snapshot)
  function serial<T>(sessionID: string, task: () => Promise<T>) {
    const next = (queues.get(sessionID) ?? Promise.resolve()).then(task, task)
    const tail = next.catch(() => undefined)
    queues.set(sessionID, tail)
    void tail.then(() => {
      if (queues.get(sessionID) === tail) queues.delete(sessionID)
    })
    return next
  }

  // Check the trailing newline before this process first appends to a file: if another process crashed mid-write,
  // the new line must not be glued to the partial one
  async function guard(target: string) {
    if (guarded.has(target)) return ""
    await fs.mkdir(path.dirname(target), { recursive: true })
    const size = await fs.stat(target).then(
      (stat) => stat.size,
      () => 0,
    )
    const tail = size ? decoder.decode(await Filesystem.readRange(target, size - 1, size)) : "\n"
    guarded.add(target)
    return tail === "\n" ? "" : "\n"
  }

  // Append the whole payload with a single write. fs.appendFile splits content over 512KB into several writes, letting
  // another process's append land mid-line; a single write in append mode is not interleaved
  async function appendWhole(target: string, data: Buffer) {
    const handle = await fs.open(target, "a")
    try {
      for (let offset = 0; offset < data.length;) offset += (await handle.write(data, offset)).bytesWritten
    } finally {
      await handle.close()
    }
  }

  async function write(sessionID: string, text: string) {
    const target = file(sessionID)
    const prefix = await guard(target)
    await appendWhole(target, Buffer.from(prefix + text)).catch((error) => {
      guarded.delete(target)
      throw error
    })
  }

  export function append(sessionID: string, lines: Line[]) {
    const text = encode(lines)
    return serial(sessionID, () => write(sessionID, text))
  }

  /**
   * Read-modify-append: computes the next version from the latest message snapshot and appends it, holding the
   * session write queue throughout. When an assistant message completes (`time.completed` set), its in-flight parts
   * are written in the same batch; this is what persists a partial reply when the user stops.
   */
  export function update(
    sessionID: string,
    messageID: string,
    change: (prev: Message.Info | undefined) => Message.Info,
  ) {
    return serial(sessionID, async () => {
      const prev = (await state(sessionID)).get(messageID)?.info
      const next = change(prev && structuredClone(prev))
      const done = next.role === "assistant" && next.time.completed !== undefined
      const settled = done ? settle(messageID) : []
      const lines: Line[] = [
        ...settled.map((part) => ({ type: "part" as const, part })),
        { type: "message", info: next },
      ]
      await write(sessionID, encode(lines))
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
  export function part(item: Message.Part, delta?: string) {
    if (item.type === "tool") {
      const status = item.state.status
      if ((status === "pending" || status === "running") && terminalParts.has(item.id)) return Promise.resolve(false)
      if (status === "completed" || status === "error") {
        terminalParts.add(item.id)
        if (terminalParts.size > 4096) terminalParts.delete(terminalParts.values().next().value!)
      }
    }
    if (hold(item, delta)) {
      inflight.set(item.id, item)
      return Promise.resolve(true)
    }
    inflight.delete(item.id)
    return append(item.sessionID, [{ type: "part", part: item }]).then(() => true)
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

  export function remove(sessionID: string, messageID: string, partID?: string) {
    if (partID) inflight.delete(partID)
    if (!partID) settle(messageID)
    return append(sessionID, [{ type: "remove", messageID, ...(partID ? { partID } : {}) }])
  }

  /** Deletes session content */
  export async function drop(sessionID: string) {
    await serial(sessionID, () => fs.rm(file(sessionID), { force: true }))
    cache.delete(sessionID)
    for (const [id, item] of inflight) if (item.sessionID === sessionID) inflight.delete(id)
    for (const [id, entry] of persisted) if (entry.sessionID === sessionID) persisted.delete(id)
  }

  /** Atomically creates the whole transcript only if it does not exist; returns false if it already exists. */
  export async function create(sessionID: string, lines: Line[]) {
    const target = file(sessionID)
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
    await Filesystem.write(temp, encode(lines))
    const created = await fs.link(temp, target).then(
      () => true,
      (error: NodeJS.ErrnoException) => exclusive(error, temp, target),
    )
    await fs.unlink(temp).catch(() => undefined)
    if (created) cache.delete(sessionID)
    return created
  }

  // Without hard link support (FAT/exFAT, some network drives) fall back to an exclusive copy, still create-if-absent
  async function exclusive(error: NodeJS.ErrnoException, temp: string, target: string) {
    if (error.code === "EEXIST") return false
    return fs.copyFile(temp, target, constants.COPYFILE_EXCL).then(
      () => true,
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === "EEXIST") return false
        throw cause
      },
    )
  }

  function parse(raw: string): Line | undefined {
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }

  function slot(messages: Map<string, Entry>, id: string) {
    const found = messages.get(id)
    if (found) return found
    const entry: Entry = { parts: new Map(), times: new Map() }
    messages.set(id, entry)
    return entry
  }

  // Unknown record types are skipped so older engines can read files written by newer ones
  function apply(messages: Map<string, Entry>, line: Line) {
    const time = (line as { time?: number }).time ?? 0
    if (line.type === "message" && typeof line.info?.id === "string") {
      const entry = slot(messages, line.info.id)
      entry.info = line.info
      entry.time = time
    }
    if (line.type === "part" && typeof line.part?.messageID === "string") {
      const entry = slot(messages, line.part.messageID)
      entry.parts.set(line.part.id, line.part)
      entry.times.set(line.part.id, time)
    }
    if (line.type === "delta") {
      const target = messages.get(line.messageID)?.parts.get(line.partID)
      if (target && "text" in target && typeof line.delta === "string") target.text += line.delta
    }
    if (line.type === "remove" && line.partID) messages.get(line.messageID)?.parts.delete(line.partID)
    if (line.type === "remove" && !line.partID) messages.delete(line.messageID)
  }

  // Reads of one session are serialized too: two concurrent reads from the same offset would apply deltas twice and
  // advance the offset twice
  function load(sessionID: string) {
    const next = (reads.get(sessionID) ?? Promise.resolve()).then(
      () => scan(sessionID),
      () => scan(sessionID),
    )
    const tail = next.catch(() => undefined)
    reads.set(sessionID, tail)
    void tail.then(() => {
      if (reads.get(sessionID) === tail) reads.delete(sessionID)
    })
    return next
  }

  // Incremental replay: parse only complete lines appended after the byte offset; reread everything when the file
  // shrinks or is replaced (inode changed)
  async function scan(sessionID: string) {
    const target = file(sessionID)
    const stat = await fs.stat(target).catch(() => undefined)
    if (!stat) {
      cache.delete(sessionID)
      return new Map<string, Entry>()
    }
    const cached = cache.get(sessionID)
    const current =
      cached && cached.ino === stat.ino && cached.offset <= stat.size
        ? cached
        : { ino: stat.ino, offset: 0, messages: new Map<string, Entry>() }
    if (stat.size > current.offset) {
      const bytes = await Filesystem.readRange(target, current.offset, stat.size)
      // Content after the last newline may be a line another process is still writing; read it next time
      const end = bytes.lastIndexOf(10)
      if (end >= 0) {
        const rows = decoder.decode(bytes.subarray(0, end)).split("\n")
        const skipped = rows.filter((raw) => {
          if (!raw.trim()) return false
          const line = parse(raw)
          if (line) apply(current.messages, line)
          return !line
        }).length
        if (skipped) log.warn("line skipped", { sessionID, count: skipped })
        current.offset += end + 1
      }
    }
    // Delete and reinsert moves the entry to the end (most recently used); evict the oldest when over the limit
    cache.delete(sessionID)
    cache.set(sessionID, current)
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    return current.messages
  }

  function state(sessionID: string) {
    return load(sessionID)
  }

  function loaded(entry: Entry): entry is Loaded {
    return entry.info !== undefined
  }

  const byID = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

  // Return a deep copy: cached objects are mutated in place by later replays, so callers must not share them
  function full(entry: Loaded): Message.FullMsg {
    const copy = structuredClone({ info: entry.info, parts: [...entry.parts.values()].toSorted(byID) })
    return { info: Message.legacy(copy.info), parts: copy.parts.map(Message.legacyPart) }
  }

  // In-flight copies override replayed parts: at the end of a turn the processor reads parts back from storage and
  // must see the latest unpersisted content
  function view(messageID: string, entry: Entry | undefined): Entry | undefined {
    const extra = [...inflight.values()].filter((item) => item.messageID === messageID)
    if (!extra.length) return entry
    const parts = new Map(entry?.parts)
    for (const item of extra) parts.set(item.id, item)
    return { info: entry?.info, time: entry?.time, parts, times: entry?.times ?? new Map() }
  }

  /** Yields messages by descending ID (newest first); copies are made lazily, so breaking early skips the rest */
  export async function* reverse(sessionID: string) {
    const list = [...(await state(sessionID)).entries()]
      .map(([id, entry]) => view(id, entry)!)
      .filter(loaded)
      .toSorted((a, b) => byID(a.info, b.info))
    for (let index = list.length - 1; index >= 0; index--) yield full(list[index]!)
  }

  export async function message(sessionID: string, messageID: string) {
    const entry = view(messageID, (await state(sessionID)).get(messageID))
    return entry && loaded(entry) ? full(entry) : undefined
  }

  /** All parts of a message; the message itself does not need to be persisted yet */
  export async function parts(sessionID: string, messageID: string) {
    const entry = view(messageID, (await state(sessionID)).get(messageID))
    return entry ? structuredClone([...entry.parts.values()].toSorted(byID)).map(Message.legacyPart) : []
  }

  /** Background cleanup after startup, delayed so it does not block startup */
  export function schedule() {
    if (scheduled) return
    scheduled = true
    setTimeout(() => void sweep(), SWEEP_DELAY_MS).unref?.()
  }

  export async function sweep() {
    const started = Date.now()
    await expire()
    await clean()
    log.info("sweep completed", { duration: Date.now() - started })
  }

  // Optional retention in days; history is kept forever by default
  async function expire() {
    const { Config } = await import("../config/config")
    const days = (await Config.global().catch(() => undefined))?.storage?.retention_days
    if (!days) return
    const { Session } = await import("./index")
    const count = await Session.expire(Date.now() - days * 86_400_000).catch((error) => {
      log.warn("retention failed", { ...failure(error) })
      return 0
    })
    log.info("retention completed", { days, count })
  }

  // Remove temp files left by a crash (create() leaves one if the process exits after writing it but before linking)
  async function clean() {
    const dir = path.dirname(file("_"))
    const cutoff = Date.now() - TEMP_TTL_MS
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith(".tmp")) continue
      const target = path.join(dir, name)
      const stat = await fs.stat(target).catch(() => undefined)
      if (stat && stat.mtimeMs < cutoff) await fs.unlink(target).catch(() => undefined)
    }
  }
}
