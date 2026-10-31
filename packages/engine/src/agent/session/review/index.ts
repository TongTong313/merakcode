/**
 * Pending agent changes in a conversation or turn. Accept advances the review baseline; reject writes only the
 * working file. Git index and commit history are independent of review decisions.
 */
import path from "path"
import fs from "fs/promises"
import { realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import z from "zod"
import { NamedError } from "@merakcode/util/error"
import { Log } from "@merakcode/log/logger"
import { BusEvent } from "../../../infra/bus/bus-event"
import { Bus } from "../../../infra/bus"
import { Instance } from "../../../infra/project/instance"
import { Checkout } from "../../../infra/project/checkout"
import { ReviewBaseline } from "./baseline"
import { Snapshot } from "../../../infra/project/snapshot"
import { Session } from ".."
import { compose, hunks, revert } from "./hunks"

export namespace Review {
  const log = Log.create({ service: "review" })

  /** Files larger than this are not diffed line by line; they are a single hunk */
  const MAX_BYTES = 1024 * 1024
  /** File details carry the full base and current text (for highlighting) only up to this combined size */
  const TEXT_LIMIT = 400_000

  export const Scope = z.enum(["session", "turn"]).meta({ ref: "ReviewScope" })
  export type Scope = z.infer<typeof Scope>

  export const Line = z
    .object({
      kind: z.enum(["context", "add", "del"]),
      text: z.string(),
      old: z.number().optional(),
      new: z.number().optional(),
      noNewline: z.literal(true).optional(),
    })
    .meta({ ref: "ReviewLine" })

  export const Hunk = z
    .object({
      id: z.string(),
      oldStart: z.number(),
      oldLines: z.number(),
      newStart: z.number(),
      newLines: z.number(),
      heading: z.string().optional(),
      lines: Line.array(),
    })
    .meta({ ref: "ReviewHunk" })
  export type Hunk = z.infer<typeof Hunk>

  export const File = z
    .object({
      file: z.string(),
      status: z.enum(["added", "deleted", "modified"]),
      /** Binary or not UTF-8: no lines, the whole file is one hunk */
      binary: z.literal(true).optional(),
      /** Too large: no lines, the whole file is one hunk */
      truncated: z.literal(true).optional(),
      additions: z.number(),
      deletions: z.number(),
      /** Number of hunks; their lines come from Review.file */
      hunks: z.number(),
      /** Hash of checkout context, base and current: changes whenever any of them changes */
      version: z.string(),
    })
    .meta({ ref: "ReviewFile" })
  export type File = z.infer<typeof File>

  export const Detail = z
    .object({
      file: z.string(),
      version: z.string(),
      hunks: Hunk.array(),
      /** Full text of base and current; absent when the file is missing, cannot be diffed or is large */
      before: z.string().optional(),
      after: z.string().optional(),
    })
    .meta({ ref: "ReviewFileDetail" })
  export type Detail = z.infer<typeof Detail>

  export const Result = z
    .object({
      scope: Scope,
      /** Opaque checkout context; null outside Git repositories */
      checkout: z.string().nullable(),
      actions: z.object({ accept: z.boolean(), reject: z.boolean() }),
      last: z.object({ decision: z.enum(["accept", "reject"]), count: z.number().int() }).optional(),
      files: File.array(),
    })
    .meta({ ref: "ReviewResult" })
  export type Result = z.infer<typeof Result>

  export const Input = z.object({
    scope: Scope,
    /** Required for the session and turn scopes */
    sessionID: z.string(),
    /** Turn scope: the user message that starts the turn */
    messageID: z.string().optional(),
  })
  export type Input = z.infer<typeof Input>

  export const Decision = Input.extend({
    expectedCheckout: z.string().nullable(),
    decision: z.enum(["accept", "reject"]),
    /** Explicit displayed versions; a file without hunks means all of its hunks. */
    files: z.object({ file: z.string(), version: z.string(), hunks: z.string().array().optional() }).array().min(1),
  })
  export type Decision = z.infer<typeof Decision>

  export const UndoInput = Input.extend({ expectedCheckout: z.string().nullable() })
  export type UndoInput = z.infer<typeof UndoInput>

  export const FileInput = Input.extend({
    file: z.string(),
    /** Version from the list; when the file has changed since, the request is stale */
    version: z.string().optional(),
    expectedCheckout: z.string().nullable().optional(),
  })
  export type FileInput = z.infer<typeof FileInput>

  /** The target file or hunk no longer exists (the client's list is stale); fetch again before retrying */
  export const StaleError = NamedError.create("ReviewStaleError", z.object({ message: z.string() }))
  /** The scope does not support this action, or a required parameter is missing */
  export const InvalidError = NamedError.create("ReviewInvalidError", z.object({ message: z.string() }))

  export const Event = {
    Updated: BusEvent.define("review.updated", z.object({ scope: Scope, sessionID: z.string().optional() })),
  }

  /** File content; undefined means the file does not exist */
  type Blob = Buffer | undefined

  type Entry = {
    /** Display path: relative with forward slashes inside the worktree, absolute outside it */
    file: string
    path: string
    before: Blob
    after: Blob
  }

  /**
   * Change to apply to one file: next is the new base (accept) or new current content (reject).
   */
  type Plan = { entry: Entry; next: Blob; ids: string[] }

  /** Undoes one write: check confirms nobody changed what was written since, run restores the previous content */
  type Undo = { check(): Promise<boolean>; run(): Promise<void> }

  type Text = { before?: string; after?: string }
  type Kind = "binary" | "truncated"
  type Context = { directory: string; checkout: string | null }

  async function context(expectedCheckout?: string | null): Promise<Context> {
    const identity = expectedCheckout === undefined ? await Checkout.current() : await Checkout.assert(expectedCheckout)
    return {
      directory: identity?.directory ?? canonical(Instance.directory),
      checkout: identity?.checkout ?? null,
    }
  }

  /** Why the file cannot be diffed line by line; undefined when it can */
  function undiffable(entry: Entry): Kind | undefined {
    const blobs = [entry.before, entry.after].filter((blob): blob is Buffer => blob !== undefined)
    if (blobs.some((blob) => blob.length > MAX_BYTES)) return "truncated"
    if (blobs.some((blob) => blob.subarray(0, 8000).includes(0))) return "binary"
    // Invalid UTF-8 (e.g. GBK) would be corrupted if written back as text, so it is handled as a whole
    if (!blobs.every((blob) => Buffer.from(blob.toString("utf8")).equals(blob))) return "binary"
  }

  const text = (entry: Entry): Text => ({
    before: entry.before?.toString("utf8"),
    after: entry.after?.toString("utf8"),
  })

  const digests = new WeakMap<Buffer, string>()
  function digest(blob: Blob) {
    if (!blob) return "-"
    const known = digests.get(blob)
    if (known) return known
    const value = createHash("sha1").update(blob).digest("hex")
    digests.set(blob, value)
    return value
  }

  /** Hash of base and current: the file's version, and the key of computed hunks */
  const version = (entry: Entry) =>
    createHash("sha1")
      .update(`${digest(entry.before)}\u0000${digest(entry.after)}`)
      .digest("hex")
      .slice(0, 16)

  const fileVersion = (entry: Entry, current: Context) =>
    createHash("sha1")
      .update(`${current.directory}\u0000${current.checkout ?? ""}\u0000${version(entry)}`)
      .digest("hex")
      .slice(0, 16)

  /** A file that cannot be diffed line by line: one hunk with no lines */
  function whole(entry: Entry): Hunk {
    return {
      id: createHash("sha1")
        .update(`whole\u0000${digest(entry.before)}\u0000${digest(entry.after)}`)
        .digest("hex")
        .slice(0, 16),
      oldStart: 0,
      oldLines: 0,
      newStart: 0,
      newLines: 0,
      lines: [],
    }
  }

  type Blocks = { kind?: Kind; list: Hunk[] }

  /** Hunks by version, most recently used last: refreshing a review only diffs the files that changed */
  const computed = new Map<string, Blocks>()
  const COMPUTED = 2000

  function compute(entry: Entry): Blocks {
    const kind = undiffable(entry)
    if (kind) return { kind, list: [whole(entry)] }
    const { before, after } = text(entry)
    return { list: hunks(before, after) }
  }

  /** Hunks of a file (shared with the cache, so never modified) */
  function blocks(entry: Entry): Blocks {
    const key = version(entry)
    const known = computed.get(key)
    if (known) {
      computed.delete(key)
      computed.set(key, known)
      return known
    }
    const value = compute(entry)
    computed.set(key, value)
    if (computed.size > COMPUTED) computed.delete(computed.keys().next().value!)
    return value
  }

  /** The base content after accepting ids, or the current content after rejecting ids */
  function apply(entry: Entry, decision: "accept" | "reject", ids: Set<string>): Blob {
    const { kind, list } = blocks(entry)
    if (kind) return list[0] && ids.has(list[0].id) === (decision === "accept") ? entry.after : entry.before
    const { before, after } = text(entry)
    const result = decision === "accept" ? compose(before, after, ids) : revert(before, after, ids)
    return result === undefined ? undefined : Buffer.from(result)
  }

  function summary(entry: Entry, current: Context): File {
    const { kind } = blocks(entry)
    const items = blocks(entry).list
    const rows = items.flatMap((hunk) => hunk.lines)
    return {
      file: entry.file,
      status: entry.before === undefined ? "added" : entry.after === undefined ? "deleted" : "modified",
      ...(kind === "binary" ? { binary: true as const } : {}),
      ...(kind === "truncated" ? { truncated: true as const } : {}),
      additions: rows.filter((line) => line.kind === "add").length,
      deletions: rows.filter((line) => line.kind === "del").length,
      hunks: items.length,
      version: fileVersion(entry, current),
    }
  }

  function detail(entry: Entry, current: Context): Detail {
    const size = (entry.before?.length ?? 0) + (entry.after?.length ?? 0)
    const full = !blocks(entry).kind && size <= TEXT_LIMIT ? text(entry) : {}
    return {
      file: entry.file,
      version: fileVersion(entry, current),
      hunks: blocks(entry).list,
      ...(full.before !== undefined ? { before: full.before } : {}),
      ...(full.after !== undefined ? { after: full.after } : {}),
    }
  }

  /** Has reviewable changes; line ending differences alone do not count */
  const changed = (entry: Entry) => blocks(entry).list.length > 0

  async function readDisk(file: string): Promise<Blob> {
    return fs.readFile(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR") return undefined
      throw error
    })
  }

  async function writeDisk(file: string, blob: Blob) {
    if (blob === undefined) return fs.rm(file, { force: true })
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, blob)
  }

  const same = (a: Blob, b: Blob) => (a === undefined || b === undefined ? a === b : a.equals(b))

  /** Changes a file on disk and records how to undo it */
  async function onDisk(file: string, write: () => Promise<unknown>): Promise<Undo> {
    const before = await readDisk(file)
    await write()
    const after = await readDisk(file)
    return { check: async () => same(await readDisk(file), after), run: () => writeDisk(file, before) }
  }

  /** The real path, or the real parent plus the last segment when the file itself is missing */
  function canonical(file: string): string {
    try {
      return realpathSync.native(file)
    } catch {
      const parent = path.dirname(file)
      if (parent === file) return file
      try {
        return path.join(realpathSync.native(parent), path.basename(file))
      } catch {
        return file
      }
    }
  }

  /**
   * Project-relative name with forward slashes. On GitHub-hosted Windows the tool path is `C:\Users\RUNNER~1\...`
   * while the worktree is the long path, so path.relative leaves the project and the review would show the absolute
   * path.
   */
  function display(file: string) {
    const relative = path.relative(canonical(Instance.worktree), canonical(file))
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/")
    return file
  }

  /** Changes a file's review baseline and records how to undo it; only review writes baselines, so there is no check */
  async function onBaseline(sessionID: string, file: string, next: Blob): Promise<Undo> {
    const before = ReviewBaseline.get(sessionID, file)
    ReviewBaseline.put(sessionID, file, next)
    return {
      check: async () => true,
      run: async () =>
        before ? ReviewBaseline.put(sessionID, file, before.content) : ReviewBaseline.remove(sessionID, file),
    }
  }

  /** Time range of the turn: from this user message to the next one */
  async function window(sessionID: string, messageID: string) {
    const messages = await Session.messages({ sessionID })
    const index = messages.findIndex((item) => item.info.id === messageID)
    if (index === -1) throw new StaleError({ message: `message ${messageID} not found` })
    const next = messages.slice(index + 1).find((item) => item.info.role === "user")
    return { start: messages[index]!.info.time.created, end: next?.info.time.created ?? Infinity }
  }

  function conversation(input: Input) {
    const sessionID = input.sessionID
    if (!sessionID) throw new InvalidError({ message: `scope ${input.scope} requires sessionID` })
    if (input.scope === "turn" && !input.messageID) throw new InvalidError({ message: "scope turn requires messageID" })
    return {
      async entries() {
        const [history, range] = await Promise.all([
          Session.descendants(sessionID).then((list) => Snapshot.history([sessionID, ...list.map((item) => item.id)])),
          input.scope === "turn" ? window(sessionID, input.messageID!) : undefined,
        ])
        const baselines = ReviewBaseline.all(sessionID)
        // The earliest backup of each file is its content before the agent first changed it
        const first = new Map<string, (typeof history)[number]>()
        for (const item of history) if (!first.has(item.file)) first.set(item.file, item)
        const files = range
          ? new Set(
              history.filter((item) => item.time >= range.start && item.time < range.end).map((item) => item.file),
            )
          : new Set([...first.keys(), ...baselines.keys()])
        const entries = await Promise.all(
          [...files].map(async (file) => ({
            file: display(file),
            path: file,
            before: baselines.has(file) ? baselines.get(file) : await first.get(file)!.read(),
            after: await readDisk(file),
          })),
        )
        return entries.filter(changed).toSorted((a, b) => a.file.localeCompare(b.file))
      },
      accept: (plan: Plan) => onBaseline(sessionID, plan.entry.path, plan.next),
      reject: (plan: Plan) => onDisk(plan.entry.path, () => writeDisk(plan.entry.path, plan.next)),
    }
  }

  /**
   * The entries behind the latest list of each review, so Review.file answers from the list the client is showing.
   * Entries hold file contents, so only a few reviews are kept.
   */
  const snapshots = new Map<string, Entry[]>()
  const SNAPSHOTS = 4

  function snapshotKey(input: Input, current: Context) {
    return [current.directory, current.checkout ?? "", input.scope, input.sessionID ?? "", input.messageID ?? ""].join(
      "\u0000",
    )
  }

  function remember(input: Input, current: Context, entries: Entry[]) {
    const key = snapshotKey(input, current)
    snapshots.delete(key)
    snapshots.set(key, entries)
    if (snapshots.size > SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!)
  }

  async function list(input: Input, current: Context): Promise<Result> {
    const entries = await conversation(input).entries()
    await Checkout.assert(current.checkout)
    remember(input, current, entries)
    return {
      scope: input.scope,
      checkout: current.checkout,
      actions: { accept: true, reject: true },
      last: historyFor(current).get(undoKey(input))?.at(-1)?.summary,
      files: entries.map((entry) => summary(entry, current)),
    }
  }

  export async function get(input: Input): Promise<Result> {
    return list(input, await context())
  }

  /** Hunks of one file at the version the client listed; stale when the file has changed since */
  export async function file(input: FileInput): Promise<Detail> {
    const current = await context(input.expectedCheckout)
    const pick = (entries: Entry[] | undefined) => entries?.find((entry) => entry.file === input.file)
    const matches = (entry: Entry | undefined) =>
      !!entry && (!input.version || fileVersion(entry, current) === input.version)
    const listed = input.version ? pick(snapshots.get(snapshotKey(input, current))) : undefined
    if (matches(listed)) {
      await Checkout.assert(current.checkout)
      return detail(listed!, current)
    }
    const entries = await conversation(input).entries()
    await Checkout.assert(current.checkout)
    remember(input, current, entries)
    const entry = pick(entries)
    if (!entry) throw new StaleError({ message: `${input.file} has no changes in scope ${input.scope}` })
    if (!matches(entry)) throw new StaleError({ message: `${input.file} changed after version ${input.version}` })
    return detail(entry, current)
  }

  // One decision at a time: two decisions reading the same base and writing back would overwrite each other
  const queues = new Map<string, Promise<void>>()

  function serial<T>(directory: string, task: () => Promise<T>) {
    const run = (queues.get(directory) ?? Promise.resolve()).then(task)
    const settled = run.then(
      () => {},
      () => {},
    )
    queues.set(directory, settled)
    return run.finally(() => {
      if (queues.get(directory) === settled) queues.delete(directory)
    })
  }

  /**
   * Recent decisions per scope, undoable step by step. Kept in memory only, so they are lost when the engine restarts.
   * The turn and session scopes share one base, so they also share the undo history.
   */
  type Step = { undos: Undo[]; summary: { decision: "accept" | "reject"; count: number } }
  const history = new Map<string, { checkout: string | null; scopes: Map<string, Step[]> }>()
  const LIMIT = 50

  function historyFor(current: Context) {
    const known = history.get(current.directory)
    if (known?.checkout === current.checkout) return known.scopes
    const scopes = new Map<string, Step[]>()
    history.set(current.directory, { checkout: current.checkout, scopes })
    return scopes
  }

  function undoKey(input: Input) {
    return input.sessionID ?? ""
  }

  function updated(input: Input) {
    Bus.publish(Event.Updated, { scope: input.scope, ...(input.sessionID ? { sessionID: input.sessionID } : {}) })
  }

  export async function decide(input: Decision): Promise<Result> {
    return Checkout.activity(() =>
      serial(canonical(Instance.worktree), async () => {
        const current = await context(input.expectedCheckout)
        const source = conversation(input)
        const entries = await source.entries()
        const targets = input.files
        // Validate everything before writing: if any target is stale, nothing is changed
        const plans = targets.map((target): Plan => {
          const entry = entries.find((item) => item.file === target.file)
          if (!entry) throw new StaleError({ message: `${target.file} has no changes in scope ${input.scope}` })
          if (fileVersion(entry, current) !== target.version)
            throw new StaleError({ message: `${target.file} changed after the displayed version` })
          const { list } = blocks(entry)
          const ids = target.hunks ?? list.map((hunk) => hunk.id)
          const missing = ids.filter((id) => !list.some((hunk) => hunk.id === id))
          if (missing.length) throw new StaleError({ message: `${target.file}: hunk ${missing.join(", ")} not found` })
          return { entry, ids, next: apply(entry, input.decision, new Set(ids)) }
        })
        await Checkout.assert(current.checkout)
        const undos: Undo[] = []
        for (const plan of plans) {
          await Checkout.assert(current.checkout)
          undos.push(await (input.decision === "accept" ? source.accept(plan) : source.reject(plan)))
        }
        const decisions = historyFor(current)
        const key = undoKey(input)
        const summary = { decision: input.decision, count: plans.reduce((count, plan) => count + plan.ids.length, 0) }
        decisions.set(key, [...(decisions.get(key) ?? []), { undos, summary }].slice(-LIMIT))
        log.info("decided", { scope: input.scope, decision: input.decision, files: plans.length })
        updated(input)
        return list(input, current)
      }),
    )
  }

  /**
   * Undoes the latest decision in this scope. Throws a stale error and changes nothing when the files changed since
   * then or there is nothing to undo.
   */
  export async function undo(input: UndoInput): Promise<Result> {
    return Checkout.activity(() =>
      serial(canonical(Instance.worktree), async () => {
        const current = await context(input.expectedCheckout)
        const decisions = historyFor(current)
        const key = undoKey(input)
        const undos = decisions.get(key)?.at(-1)?.undos
        if (!undos) throw new StaleError({ message: `nothing to undo in scope ${input.scope}` })
        const fresh = await Promise.all(undos.map((item) => item.check()))
        if (fresh.includes(false)) {
          // This step can no longer be undone, so earlier steps cannot be undone past it either
          decisions.delete(key)
          throw new StaleError({ message: "the files changed after the decision" })
        }
        await Checkout.assert(current.checkout)
        for (const item of undos.toReversed()) {
          await Checkout.assert(current.checkout)
          await item.run()
        }
        decisions.get(key)!.pop()
        log.info("undone", { scope: input.scope, files: undos.length })
        updated(input)
        return list(input, current)
      }),
    )
  }
}
