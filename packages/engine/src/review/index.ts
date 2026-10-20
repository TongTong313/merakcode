/**
 * Review: lists a set of changes as files and hunks that can be accepted or rejected one by one.
 *
 * Every scope has a "base" and a "current" version; hunks are the difference between them (see ./hunks):
 * - session: base = the content before the agent (including subsessions) first changed the file, moved forward on
 *   accept; current = disk
 * - turn: same as session, but only files touched in this turn
 * - unstaged: base = git index, current = worktree; accept stages the hunk, reject discards it
 * - staged: base = HEAD, current = index; only reject, which unstages the hunk
 * - branch: base = merge base with the base branch, current = worktree; accept only records a mark, reject writes
 *   back to the worktree
 *
 * Accept moves the base to compose(base, current, accepted hunks); reject reverts the current version to
 * compose(base, current, remaining hunks). Binary, oversized or non-UTF-8 files are a single hunk and can only be
 * accepted or rejected as a whole.
 */
import path from "path"
import fs from "fs/promises"
import { createHash } from "node:crypto"
import z from "zod"
import { NamedError } from "@merakcode/util/error"
import { Process } from "@merakcode/util/process"
import { Log } from "@merakcode/log/logger"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import { Instance } from "../project/instance"
import { Vcs } from "../project/vcs"
import { Storage } from "../storage/storage"
import { Snapshot } from "../snapshot"
import { Session } from "../session"
import { compose, hunks, revert } from "./hunks"

export namespace Review {
  const log = Log.create({ service: "review" })

  /** Files larger than this are not diffed line by line; they are a single hunk */
  const MAX_BYTES = 1024 * 1024

  export const Scope = z.enum(["session", "turn", "unstaged", "staged", "branch"]).meta({ ref: "ReviewScope" })
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
      /** Already accepted (marked) in the branch scope */
      state: z.literal("accepted").optional(),
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
      /** Full text of base and current; absent when the file is missing, binary or too large */
      before: z.string().optional(),
      after: z.string().optional(),
      additions: z.number(),
      deletions: z.number(),
      hunks: Hunk.array(),
      accepted: z.number(),
    })
    .meta({ ref: "ReviewFile" })
  export type File = z.infer<typeof File>

  export const Result = z
    .object({
      scope: Scope,
      /** Base branch used by the branch scope */
      base: z.string().optional(),
      actions: z.object({ accept: z.boolean(), reject: z.boolean() }),
      files: File.array(),
    })
    .meta({ ref: "ReviewResult" })
  export type Result = z.infer<typeof Result>

  export const Input = z.object({
    scope: Scope,
    /** Required for the session and turn scopes */
    sessionID: z.string().optional(),
    /** Turn scope: the user message that starts the turn */
    messageID: z.string().optional(),
    /** Branch scope: base branch, defaults to the repository's default branch */
    base: z.string().optional(),
  })
  export type Input = z.infer<typeof Input>

  export const Decision = Input.extend({
    decision: z.enum(["accept", "reject"]),
    /** Omitted means all files; a file without hunks means all of its hunks */
    files: z.object({ file: z.string(), hunks: z.string().array().optional() }).array().optional(),
  })
  export type Decision = z.infer<typeof Decision>

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
    /** File mode in the index, reused when writing the index */
    mode?: string
    /** Hunks already accepted in the branch scope */
    accepted?: Set<string>
  }

  /**
   * Change to apply to one file: next is the new base (accept) or new current content (reject); whole means the file
   * cannot be diffed line by line and is handled as a whole
   */
  type Plan = { entry: Entry; next: Blob; ids: string[]; whole: boolean }

  /** Undoes one write: check confirms nobody changed what was written since, run restores the previous content */
  type Undo = { check(): Promise<boolean>; run(): Promise<void> }

  type Source = {
    base?: string
    actions: { accept: boolean; reject: boolean }
    entries(): Promise<Entry[]>
    /** Moves the base forward to next */
    accept(plan: Plan): Promise<Undo>
    /** Reverts the current content to next */
    reject(plan: Plan): Promise<Undo>
  }

  type Text = { before?: string; after?: string }

  /** Returns the text when the file can be diffed line by line, otherwise the reason it cannot */
  function textual(entry: Entry): Text | "binary" | "truncated" {
    const blobs = [entry.before, entry.after].filter((blob): blob is Buffer => blob !== undefined)
    if (blobs.some((blob) => blob.length > MAX_BYTES)) return "truncated"
    if (blobs.some((blob) => blob.subarray(0, 8000).includes(0))) return "binary"
    // Invalid UTF-8 (e.g. GBK) would be corrupted if written back as text, so it is handled as a whole
    if (!blobs.every((blob) => Buffer.from(blob.toString("utf8")).equals(blob))) return "binary"
    return { before: entry.before?.toString("utf8"), after: entry.after?.toString("utf8") }
  }

  const digest = (blob: Blob) => (blob ? createHash("sha1").update(blob).digest("hex") : "-")

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

  function blocks(entry: Entry) {
    const text = textual(entry)
    if (typeof text === "string") return { text: undefined, kind: text, list: [whole(entry)] }
    return { text, kind: undefined, list: hunks(text.before, text.after) }
  }

  /** The base content after accepting ids, or the current content after rejecting ids */
  function apply(entry: Entry, decision: "accept" | "reject", ids: Set<string>): Blob {
    const { text, list } = blocks(entry)
    if (!text) return list[0] && ids.has(list[0].id) === (decision === "accept") ? entry.after : entry.before
    const result = decision === "accept" ? compose(text.before, text.after, ids) : revert(text.before, text.after, ids)
    return result === undefined ? undefined : Buffer.from(result)
  }

  function view(entry: Entry): File {
    const { text, kind, list } = blocks(entry)
    const accepted = entry.accepted ?? new Set()
    const items: Hunk[] = list.map((hunk) => (accepted.has(hunk.id) ? { ...hunk, state: "accepted" } : hunk))
    const rows = items.flatMap((hunk) => hunk.lines)
    return {
      file: entry.file,
      status: entry.before === undefined ? "added" : entry.after === undefined ? "deleted" : "modified",
      ...(kind === "binary" ? { binary: true as const } : {}),
      ...(kind === "truncated" ? { truncated: true as const } : {}),
      ...(text?.before !== undefined ? { before: text.before } : {}),
      ...(text?.after !== undefined ? { after: text.after } : {}),
      additions: rows.filter((line) => line.kind === "add").length,
      deletions: rows.filter((line) => line.kind === "del").length,
      hunks: items,
      accepted: items.filter((hunk) => hunk.state === "accepted").length,
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

  /** Changes a storage entry and records how to undo it; only review writes this storage, so there is no check */
  async function onStorage<T>(key: string[], fallback: T, change: (value: T) => T): Promise<Undo> {
    const read = () => Storage.read<T>(key).catch(() => structuredClone(fallback))
    const before = await read()
    await Storage.write(key, change(structuredClone(before)))
    return { check: async () => true, run: () => Storage.write(key, before) }
  }

  function display(file: string) {
    const relative = path.relative(Instance.worktree, file)
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/")
    return file
  }

  // Blobs are read exactly as stored in the repository (no line ending conversion), and comparisons with the worktree
  // ignore CRLF/LF. Binary files handled as a whole go through git add / git restore, so filters like LFS still apply.

  const EMPTY = /^0+$/

  function git(args: string[], stdin?: string | Buffer) {
    return Process.run(["git", "-c", "core.quotepath=off", ...args], { cwd: Instance.worktree, stdin, nothrow: true })
  }

  async function must(args: string[], stdin?: string | Buffer) {
    const result = await git(args, stdin)
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`)
    return result.text()
  }

  type Raw = { file: string; srcMode: string; dstMode: string; srcSha: string; dstSha: string; status: string }

  /** git diff --raw -z: ":srcmode dstmode srcsha dstsha status\0path\0" */
  async function diffRaw(args: string[]): Promise<Raw[]> {
    const parts = (await must(["diff", "--raw", "-z", "--no-renames", "--no-abbrev", ...args])).split("\0")
    return parts.flatMap((meta, index) => {
      if (!meta.startsWith(":")) return []
      const [srcMode = "", dstMode = "", srcSha = "", dstSha = "", status = ""] = meta.slice(1).split(" ")
      const file = parts[index + 1]
      // Conflicted files, submodules and symlinks are not handled by review
      if (!file || status === "U" || [srcMode, dstMode].some((mode) => mode === "160000" || mode === "120000"))
        return []
      return [{ file, srcMode, dstMode, srcSha, dstSha, status }]
    })
  }

  async function untracked() {
    return (await must(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)
  }

  /** Reads blobs in one batch (git cat-file --batch); an all-zero sha means the file does not exist */
  async function blobs(shas: string[]): Promise<Blob[]> {
    const wanted = [...new Set(shas.filter((sha) => !EMPTY.test(sha)))]
    const result = new Map<string, Buffer>()
    if (wanted.length) {
      const output = (await git(["cat-file", "--batch"], wanted.join("\n") + "\n")).stdout
      let offset = 0
      for (const sha of wanted) {
        const end = output.indexOf(0x0a, offset)
        if (end === -1) break
        const header = output.subarray(offset, end).toString().split(" ")
        offset = end + 1
        if (header[1] === "missing" || header.length < 3) continue
        const size = Number(header[2])
        result.set(sha, output.subarray(offset, offset + size))
        offset += size + 1
      }
    }
    return shas.map((sha) => result.get(sha))
  }

  /** Mode used when a new file is written to the index */
  async function newMode(file: string) {
    if (process.platform === "win32") return "100644"
    const stat = await fs.stat(file).catch(() => undefined)
    return stat && stat.mode & 0o111 ? "100755" : "100644"
  }

  /** Writes the content to the index unchanged; undefined removes the file from the index */
  async function writeIndex(entry: Entry, blob: Blob) {
    if (blob === undefined) {
      await must(["update-index", "--force-remove", "--", entry.file])
      return
    }
    const sha = (await must(["hash-object", "-w", "--no-filters", "--stdin"], blob)).trim()
    const mode = entry.mode && !EMPTY.test(entry.mode) ? entry.mode : await newMode(entry.path)
    await must(["update-index", "--add", "--cacheinfo", `${mode},${sha},${entry.file}`])
  }

  /** "mode,sha" of the file in the index; undefined when it is not in the index */
  async function indexEntry(file: string) {
    const line = (await must(["ls-files", "-s", "-z", "--", file])).split("\0")[0]
    if (!line) return
    const [mode, sha] = line.split(/\s/)
    return `${mode},${sha}`
  }

  /** Changes the index and records how to undo it */
  async function onIndex(file: string, write: () => Promise<unknown>): Promise<Undo> {
    const before = await indexEntry(file)
    await write()
    const after = await indexEntry(file)
    return {
      check: async () => (await indexEntry(file)) === after,
      run: async () => {
        if (before) await must(["update-index", "--add", "--cacheinfo", `${before},${file}`])
        else await must(["update-index", "--force-remove", "--", file])
      },
    }
  }

  /** Restores the worktree file from source (the index by default); deletes it when the base has no such file */
  async function restore(plan: Plan, source?: string) {
    if (plan.next === undefined) return writeDisk(plan.entry.path, undefined)
    await must(["restore", ...(source ? [`--source=${source}`] : []), "--worktree", "--", plan.entry.file])
  }

  /** Worktree changes relative to ref (the index by default), including untracked files */
  async function worktreeEntries(ref?: string): Promise<Entry[]> {
    const [raw, extra] = await Promise.all([diffRaw(ref ? [ref] : []), untracked()])
    const tracked = new Set(raw.map((item) => item.file))
    const list = [
      ...raw.map((item) => ({ file: item.file, sha: item.srcSha, mode: item.srcMode })),
      ...extra.filter((file) => !tracked.has(file)).map((file) => ({ file, sha: "0", mode: "0" })),
    ]
    const before = await blobs(list.map((item) => item.sha))
    const entries = await Promise.all(
      list.map(async (item, index) => {
        const file = path.join(Instance.worktree, item.file)
        return { file: item.file, path: file, before: before[index], after: await readDisk(file), mode: item.mode }
      }),
    )
    return entries.filter(changed)
  }

  function unstaged(): Source {
    return {
      actions: { accept: true, reject: true },
      entries: () => worktreeEntries(),
      accept: (plan) =>
        onIndex(plan.entry.file, () =>
          plan.whole ? must(["add", "-A", "--", plan.entry.file]) : writeIndex(plan.entry, plan.next),
        ),
      reject: (plan) =>
        onDisk(plan.entry.path, () => (plan.whole ? restore(plan) : writeDisk(plan.entry.path, plan.next))),
    }
  }

  function staged(): Source {
    return {
      actions: { accept: false, reject: true },
      async entries() {
        const raw = await diffRaw(["--cached"])
        const [before, after] = await Promise.all([
          blobs(raw.map((item) => item.srcSha)),
          blobs(raw.map((item) => item.dstSha)),
        ])
        const entries = raw.map((item, index) => ({
          file: item.file,
          path: path.join(Instance.worktree, item.file),
          before: before[index],
          after: after[index],
          mode: EMPTY.test(item.dstMode) ? item.srcMode : item.dstMode,
        }))
        return entries.filter(changed)
      },
      accept: async () => nothing,
      reject: (plan) => onIndex(plan.entry.file, () => writeIndex(plan.entry, plan.next)),
    }
  }

  type Marks = Record<string, Record<string, string[]>>

  async function branch(input: Input): Promise<Source> {
    const base = input.base ?? (await Vcs.defaultBranch())?.ref
    const fork = base ? (await git(["merge-base", base, "HEAD"])).text().trim() : ""
    const key = ["review_branch", Instance.project.id]
    return {
      base,
      actions: { accept: true, reject: true },
      async entries() {
        if (!base || !fork) return []
        const marks = await Storage.read<Marks>(key).catch(() => ({}) as Marks)
        const entries = await worktreeEntries(fork)
        return entries.map((entry) => ({ ...entry, accepted: new Set(marks[base]?.[entry.file] ?? []) }))
      },
      accept(plan) {
        const current = new Set(blocks(plan.entry).list.map((hunk) => hunk.id))
        return onStorage<Marks>(key, {}, (marks) => {
          // Keep only hunks that still exist: an edited hunk gets a new id, so its old mark is obsolete
          const kept = [...new Set([...(marks[base!]?.[plan.entry.file] ?? []), ...plan.ids])].filter((id) =>
            current.has(id),
          )
          return { ...marks, [base!]: { ...marks[base!], [plan.entry.file]: kept } }
        })
      },
      reject: (plan) =>
        onDisk(plan.entry.path, () => (plan.whole ? restore(plan, fork) : writeDisk(plan.entry.path, plan.next))),
    }
  }

  type Baseline = { exists: boolean; data?: string }
  type Baselines = { baselines: Record<string, Baseline> }

  const encode = (blob: Blob): Baseline => (blob ? { exists: true, data: blob.toString("base64") } : { exists: false })
  const decode = (item: Baseline): Blob => (item.exists ? Buffer.from(item.data ?? "", "base64") : undefined)

  /** Time range of the turn: from this user message to the next one */
  async function window(sessionID: string, messageID: string) {
    const messages = await Session.messages({ sessionID })
    const index = messages.findIndex((item) => item.info.id === messageID)
    if (index === -1) throw new StaleError({ message: `message ${messageID} not found` })
    const next = messages.slice(index + 1).find((item) => item.info.role === "user")
    return { start: messages[index]!.info.time.created, end: next?.info.time.created ?? Infinity }
  }

  function conversation(input: Input): Source {
    const sessionID = input.sessionID
    if (!sessionID) throw new InvalidError({ message: `scope ${input.scope} requires sessionID` })
    if (input.scope === "turn" && !input.messageID) throw new InvalidError({ message: "scope turn requires messageID" })
    const key = ["review", sessionID]
    const stored = () => Storage.read<Baselines>(key).catch(() => ({ baselines: {} }) as Baselines)
    return {
      actions: { accept: true, reject: true },
      async entries() {
        const [history, baselines, range] = await Promise.all([
          Session.descendants(sessionID).then((list) => Snapshot.history([sessionID, ...list.map((item) => item.id)])),
          stored().then((item) => item.baselines),
          input.scope === "turn" ? window(sessionID, input.messageID!) : undefined,
        ])
        // The earliest backup of each file is its content before the agent first changed it
        const first = new Map<string, (typeof history)[number]>()
        for (const item of history) if (!first.has(item.file)) first.set(item.file, item)
        const files = range
          ? new Set(
              history.filter((item) => item.time >= range.start && item.time < range.end).map((item) => item.file),
            )
          : new Set([...first.keys(), ...Object.keys(baselines)])
        const entries = await Promise.all(
          [...files].map(async (file) => ({
            file: display(file),
            path: file,
            before: baselines[file] ? decode(baselines[file]) : await first.get(file)!.read(),
            after: await readDisk(file),
          })),
        )
        return entries.filter(changed).toSorted((a, b) => a.file.localeCompare(b.file))
      },
      accept: (plan) =>
        onStorage<Baselines>(key, { baselines: {} }, (current) => ({
          baselines: { ...current.baselines, [plan.entry.path]: encode(plan.next) },
        })),
      reject: (plan) => onDisk(plan.entry.path, () => writeDisk(plan.entry.path, plan.next)),
    }
  }

  const nothing: Undo = { check: async () => true, run: async () => {} }

  const none: Source = {
    actions: { accept: false, reject: false },
    entries: async () => [],
    accept: async () => nothing,
    reject: async () => nothing,
  }

  async function open(input: Input): Promise<Source> {
    if (input.scope === "session" || input.scope === "turn") return conversation(input)
    if (Instance.project.vcs !== "git") return none
    if (input.scope === "unstaged") return unstaged()
    if (input.scope === "staged") return staged()
    return branch(input)
  }

  export async function get(input: Input): Promise<Result> {
    const source = await open(input)
    const entries = await source.entries()
    return {
      scope: input.scope,
      ...(source.base ? { base: source.base } : {}),
      actions: source.actions,
      files: entries.map(view),
    }
  }

  // One decision at a time: two decisions reading the same base and writing back would overwrite each other
  let queue = Promise.resolve()

  function serial<T>(task: () => Promise<T>) {
    const run = queue.then(task)
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /**
   * Recent decisions per scope, undoable step by step. Kept in memory only, so they are lost when the engine restarts.
   * The turn and session scopes share one base, so they also share the undo history.
   */
  const history = new Map<string, Undo[][]>()
  const LIMIT = 50

  function undoKey(input: Input, source: Source) {
    const scope = input.scope === "turn" ? "session" : input.scope
    return [Instance.directory, scope, input.sessionID ?? "", source.base ?? ""].join("\u0000")
  }

  function updated(input: Input) {
    Bus.publish(Event.Updated, { scope: input.scope, ...(input.sessionID ? { sessionID: input.sessionID } : {}) })
  }

  export async function decide(input: Decision): Promise<Result> {
    await serial(async () => {
      const source = await open(input)
      if (!source.actions[input.decision])
        throw new InvalidError({ message: `scope ${input.scope} does not support ${input.decision}` })
      const entries = await source.entries()
      const targets = input.files ?? entries.map((entry) => ({ file: entry.file, hunks: undefined }))
      // Validate everything before writing: if any target is stale, nothing is changed
      const plans = targets.map((target): Plan => {
        const entry = entries.find((item) => item.file === target.file)
        if (!entry) throw new StaleError({ message: `${target.file} has no changes in scope ${input.scope}` })
        const { text, list } = blocks(entry)
        const ids = target.hunks ?? list.map((hunk) => hunk.id)
        const missing = ids.filter((id) => !list.some((hunk) => hunk.id === id))
        if (missing.length) throw new StaleError({ message: `${target.file}: hunk ${missing.join(", ")} not found` })
        return { entry, ids, next: apply(entry, input.decision, new Set(ids)), whole: !text }
      })
      const undos: Undo[] = []
      for (const plan of plans)
        undos.push(await (input.decision === "accept" ? source.accept(plan) : source.reject(plan)))
      const key = undoKey(input, source)
      history.set(key, [...(history.get(key) ?? []), undos].slice(-LIMIT))
      log.info("decided", { scope: input.scope, decision: input.decision, files: plans.length })
      updated(input)
    })
    return get(input)
  }

  /**
   * Undoes the latest decision in this scope. Throws a stale error and changes nothing when the files changed since
   * then or there is nothing to undo.
   */
  export async function undo(input: Input): Promise<Result> {
    await serial(async () => {
      const key = undoKey(input, await open(input))
      const undos = history.get(key)?.pop()
      if (!undos) throw new StaleError({ message: `nothing to undo in scope ${input.scope}` })
      const fresh = await Promise.all(undos.map((item) => item.check()))
      if (fresh.includes(false)) {
        // This step can no longer be undone, so earlier steps cannot be undone past it either
        history.delete(key)
        throw new StaleError({ message: "the files changed after the decision" })
      }
      for (const item of undos.toReversed()) await item.run()
      log.info("undone", { scope: input.scope, files: undos.length })
      updated(input)
    })
    return get(input)
  }
}
