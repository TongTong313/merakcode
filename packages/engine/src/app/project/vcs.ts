import { BusEvent } from "../../infra/bus/bus-event"
import { Bus } from "../../infra/bus"
import { formatPatch, structuredPatch } from "diff"
import z from "zod"
import { Log } from "@merakcode/log/logger"
import { Process } from "@merakcode/util/process"
import { Instance } from "../../infra/project/instance"
import { FileWatcher } from "../../agent/workspace/file/watcher"
import { Checkout } from "../../infra/project/checkout"
import { NamedError } from "@merakcode/util/error"
import path from "node:path"
import { Project } from "../../infra/project/project"
import { stat } from "node:fs/promises"

const log = Log.create({ service: "vcs" })

export namespace Vcs {
  export const Event = {
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
        branch: z.string().optional(),
      }),
    ),
    HeadUpdated: BusEvent.define(
      "vcs.head.updated",
      z.object({
        branch: z.string().nullable(),
        head: z.string().nullable(),
        checkout: z.string().nullable(),
        branchChanged: z.boolean(),
      }),
    ),
  }

  export const Info = z
    .object({
      branch: z.string(),
      head: z.string().nullable(),
      checkout: z.string().nullable(),
      default_branch: z.string().optional(),
      /** Remote to push to (the upstream's remote, else origin or the only remote); absent without remotes */
      remote: z.string().optional(),
      /** Commits ahead of the upstream; absent without an upstream */
      ahead: z.number().optional(),
      /** Commits behind the upstream; absent without an upstream */
      behind: z.number().optional(),
      /** Files with staged changes */
      staged: z.number().int(),
      /** Tracked files with unstaged changes */
      unstaged: z.number().int(),
      /** Files not yet tracked */
      untracked: z.number().int(),
    })
    .meta({
      ref: "VcsInfo",
    })
  export type Info = z.infer<typeof Info>

  export const BranchOptions = z
    .object({
      directory: z.string(),
      current: z
        .object({ branch: z.string().nullable(), head: z.string().nullable(), checkout: z.string() })
        .nullable(),
      defaultBranch: z.string().optional(),
      branches: z.object({ name: z.string(), worktree: z.string().optional() }).array(),
      blocked: z
        .object({
          reason: z.enum(["not_git", "unborn", "managed_worktree", "dirty", "busy", "git_operation"]),
          staged: z.number().int().optional(),
          unstaged: z.number().int().optional(),
          untracked: z.number().int().optional(),
          operation: z.string().optional(),
        })
        .optional(),
    })
    .meta({ ref: "VcsBranchOptions" })
  export type BranchOptions = z.infer<typeof BranchOptions>

  export const SwitchInput = z
    .object({ branch: z.string().min(1).max(2000), expectedCheckout: z.string() })
    .meta({ ref: "VcsSwitchInput" })
  export type SwitchInput = z.infer<typeof SwitchInput>

  export const SwitchResult = z
    .object({ branch: z.string(), head: z.string(), checkout: z.string(), changed: z.boolean() })
    .meta({ ref: "VcsSwitchResult" })
  export type SwitchResult = z.infer<typeof SwitchResult>

  export const InvalidBranchError = NamedError.create(
    "VcsInvalidBranchError",
    z.object({ branch: z.string(), message: z.string() }),
  )
  export const SwitchFailedError = NamedError.create("VcsSwitchFailedError", z.object({ message: z.string() }))

  /** Diff of the git working tree or the branch; last-turn is served by session.diff, not here */
  export const Mode = z.enum(["git", "branch", "last-turn"])
  export type Mode = z.infer<typeof Mode>

  /** Matches OpenCode's VcsFileDiff; separate from Snapshot.FileDiff, returned by /vcs/diff */
  export const FileDiff = z
    .object({
      file: z.string(),
      patch: z.string().optional(),
      additions: z.number(),
      deletions: z.number(),
      status: z.enum(["added", "deleted", "modified"]).optional(),
      /** The patch was too large and replaced by an empty diff; additions/deletions still come from numstat */
      truncated: z.boolean().optional(),
    })
    .meta({
      ref: "VcsFileDiff",
    })
  export type FileDiff = z.infer<typeof FileDiff>

  const DEFAULT_CONTEXT = 12
  const MAX_PATCH_BYTES = 10_000_000
  const MAX_TOTAL_PATCH_BYTES = 10_000_000

  type PatchLimits = {
    maxPatchBytes: number
    maxTotalBytes: number
  }

  /** A valid, empty unified patch, used in place of oversized patches */
  function emptyPatch(file: string) {
    return formatPatch(structuredPatch(file, file, "", "", "", "", { context: 0 }))
  }

  function applyPatchLimits(
    file: string,
    patch: string,
    total: number,
    limits: PatchLimits,
  ): { patch: string; truncated: boolean; total: number } {
    const bytes = Buffer.byteLength(patch, "utf8")
    if (bytes > limits.maxPatchBytes) {
      return { patch: emptyPatch(file), truncated: true, total }
    }
    if (total + bytes > limits.maxTotalBytes) {
      return { patch: emptyPatch(file), truncated: true, total }
    }
    return { patch, truncated: false, total: total + bytes }
  }

  type StatusEntry = {
    file: string
    status: "added" | "deleted" | "modified"
    untracked: boolean
  }

  /** porcelain v1 -z: NUL-separated "XY path" entries */
  function parseStatus(raw: string): StatusEntry[] {
    return raw
      .split("\0")
      .filter(Boolean)
      .flatMap((item) => {
        const file = item.slice(3)
        if (!file) return []
        const code = item.slice(0, 2)
        return [
          {
            file: unquoteGitPath(file),
            status: statusFromCode(code),
            untracked: code === "??",
          } satisfies StatusEntry,
        ]
      })
  }

  /** numstat -z: "add\t del\t path" entries */
  function parseNumstat(raw: string) {
    const stats = new Map<string, { additions: number; deletions: number }>()
    for (const item of raw.split("\0").filter(Boolean)) {
      const a = item.indexOf("\t")
      const b = item.indexOf("\t", a + 1)
      if (a === -1 || b === -1) continue
      const file = unquoteGitPath(item.slice(b + 1))
      if (!file) continue
      const adds = item.slice(0, a)
      const dels = item.slice(a + 1, b)
      stats.set(file, {
        additions: adds === "-" ? 0 : Number.parseInt(adds || "0", 10) || 0,
        deletions: dels === "-" ? 0 : Number.parseInt(dels || "0", 10) || 0,
      })
    }
    return stats
  }

  function statusFromCode(code: string): "added" | "deleted" | "modified" {
    if (code === "??") return "added"
    if (code.includes("U")) return "modified"
    if (code.includes("A") && !code.includes("D")) return "added"
    if (code.includes("D") && !code.includes("A")) return "deleted"
    return "modified"
  }

  /** Unquotes a path git quoted (because of spaces, tabs, ...) */
  function unquoteGitPath(input: string) {
    if (!input.startsWith('"') || !input.endsWith('"')) return input
    let out = ""
    for (let i = 1; i < input.length - 1; i++) {
      const char = input[i]
      if (char !== "\\") {
        out += char
        continue
      }
      const next = input[++i]
      if (next === "t") out += "\t"
      else if (next === "n") out += "\n"
      else if (next === "r") out += "\r"
      else if (next === '"' || next === "\\") out += next
      else out += next ?? ""
    }
    return out
  }

  function countPatchLines(patch: string, prefix: "+" | "-") {
    return patch.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}`)).length
  }

  function mergeStatusEntries(...lists: StatusEntry[]) {
    const out = new Map<string, StatusEntry>()
    for (const item of lists) {
      if (!out.has(item.file)) out.set(item.file, item)
    }
    return [...out.values()]
  }

  /** Unquotes a quoted path in a diff --git header */
  function parseQuotedPath(value: string) {
    let out = ""
    for (let idx = 1; idx < value.length; idx++) {
      const char = value[idx]
      if (char === '"') return out
      if (char !== "\\") {
        out += char
        continue
      }
      const next = value[++idx]
      if (next === "t") out += "\t"
      else if (next === "n") out += "\n"
      else if (next === "r") out += "\r"
      else if (next === '"' || next === "\\") out += next
      else out += next ?? ""
    }
    return out
  }

  function parsePathToken(value: string) {
    if (!value.startsWith('"')) return value.split("\t")[0] ?? value
    return parseQuotedPath(value)
  }

  function fileFromDiffPath(value: string | undefined) {
    if (!value || value === "/dev/null") return
    const file = parsePathToken(value)
    if (file.startsWith("a/") || file.startsWith("b/")) return file.slice(2)
    return file
  }

  function fileFromGitHeader(header: string) {
    if (header.startsWith('"')) {
      const first = parseQuotedPath(header)
      const second = header.slice(first.length + 2).trimStart()
      if (!second) return
      if (!second.startsWith('"')) return fileFromDiffPath(second)
      return fileFromDiffPath(parseQuotedPath(second))
    }
    const separator = header.indexOf(" b/")
    if (separator === -1) return
    return fileFromDiffPath(header.slice(separator + 1))
  }

  /** File path of a unified patch chunk, used to split a batched diff */
  function fileFromPatchChunk(chunk: string) {
    const next = /^\+\+\+ (.+)$/m.exec(chunk)?.[1]
    const before = /^--- (.+)$/m.exec(chunk)?.[1]
    const file = fileFromDiffPath(next) ?? fileFromDiffPath(before)
    if (file) return file
    const header = /^diff --git (.+)$/m.exec(chunk)?.[1]
    if (!header) return
    return fileFromGitHeader(header)
  }

  /** Splits batched patch output at diff --git boundaries */
  function splitGitPatch(text: string) {
    const starts = [...text.matchAll(/(?:^|\n)diff --git /g)].map((match) =>
      match[0].startsWith("\n") ? (match.index ?? 0) + 1 : (match.index ?? 0),
    )
    if (starts.length === 0) return text ? [text] : []
    return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length))
  }

  function buildPatchMap(patchText: string, tracked: StatusEntry[], limits: PatchLimits) {
    const outputTruncated = Buffer.byteLength(patchText, "utf8") >= limits.maxTotalBytes
    const chunks = splitGitPatch(patchText)
    const end = outputTruncated ? Math.max(0, chunks.length - 1) : chunks.length
    const map = chunks.slice(0, end).reduce((acc, patch, index) => {
      const file = fileFromPatchChunk(patch) ?? tracked[index]?.file
      if (!file) return acc
      acc.set(file, (acc.get(file) ?? "") + patch)
      return acc
    }, new Map<string, string>())
    return { map, capped: outputTruncated }
  }

  /**
   * Without optional locks git status does not rewrite .git/index under index.lock; polling it in the background would
   * otherwise make the user's own git add or commit fail meanwhile. git diff ignores the setting.
   */
  function withoutOptionalLocks() {
    return { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  }

  async function patchAll(cwd: string, ref: string, context: number) {
    return (
      await Process.run(
        ["git", "diff", "--patch", "--no-ext-diff", "--no-renames", `--unified=${context}`, ref, "--", "."],
        { cwd, nothrow: true },
      )
    ).text()
  }

  async function patchForFile(cwd: string, file: string, ref: string, untracked: boolean, context: number) {
    if (untracked) {
      return (
        await Process.run(
          ["git", "diff", "--no-index", "--no-ext-diff", `--unified=${context}`, "--", "/dev/null", file],
          { cwd, nothrow: true },
        )
      ).text()
    }
    return (
      await Process.run(["git", "diff", ref, "--no-ext-diff", "--no-renames", `--unified=${context}`, "--", file], {
        cwd,
        nothrow: true,
      })
    ).text()
  }

  async function hasHead(cwd: string) {
    return (await Process.run(["git", "rev-parse", "--verify", "HEAD"], { cwd, nothrow: true })).exitCode === 0
  }

  async function assembleFileDiffs(
    cwd: string,
    ref: string,
    files: StatusEntry[],
    stats: Map<string, { additions: number; deletions: number }>,
    batchMap: Map<string, string>,
    batchCapped: boolean,
    context: number,
    limits: PatchLimits,
  ) {
    const result: FileDiff[] = []
    let total = 0

    for (const entry of files.toSorted((a, b) => a.file.localeCompare(b.file))) {
      const stat = stats.get(entry.file)
      let patch: string
      let truncated = false

      if (entry.untracked) {
        const raw = await patchForFile(cwd, entry.file, ref, true, context)
        const limited = applyPatchLimits(entry.file, raw, total, limits)
        patch = limited.patch
        truncated = limited.truncated
        total = limited.total
      } else {
        const batched = batchMap.get(entry.file)
        if (batched !== undefined) {
          const limited = applyPatchLimits(entry.file, batched, total, limits)
          patch = limited.patch
          truncated = limited.truncated
          total = limited.total
        } else if (batchCapped) {
          patch = emptyPatch(entry.file)
          truncated = true
        } else {
          const raw = await patchForFile(cwd, entry.file, ref, false, context)
          const limited = applyPatchLimits(entry.file, raw, total, limits)
          patch = limited.patch
          truncated = limited.truncated
          total = limited.total
        }
      }

      result.push({
        file: entry.file,
        patch,
        additions: stat?.additions ?? countPatchLines(patch, "+"),
        deletions: stat?.deletions ?? countPatchLines(patch, "-"),
        status: entry.status,
        ...(truncated ? { truncated: true } : {}),
      })
    }
    return result
  }

  /** name-status -z: "code\0file" pairs */
  function parseNameStatus(raw: string): StatusEntry[] {
    const parts = raw.split("\0").filter(Boolean)
    const result: StatusEntry[] = []
    for (let i = 0; i < parts.length; i += 2) {
      const code = parts[i]
      const file = parts[i + 1]
      if (!code || !file) continue
      result.push({
        file: unquoteGitPath(file),
        status: statusFromNameStatus(code),
        untracked: false,
      })
    }
    return result
  }

  function statusFromNameStatus(code: string): "added" | "deleted" | "modified" {
    if (code.startsWith("A")) return "added"
    if (code.startsWith("D")) return "deleted"
    return "modified"
  }

  async function diffStatusOnly(cwd: string, context: number, limits: PatchLimits) {
    const statusRaw = (
      await Process.run(["git", "status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."], {
        cwd,
        env: withoutOptionalLocks(),
        nothrow: true,
      })
    ).text()
    const files = parseStatus(statusRaw)
    if (files.length === 0) return []
    return assembleFileDiffs(cwd, "", files, new Map(), new Map(), false, context, limits)
  }

  async function diffWorkingTree(cwd: string, context: number, limits: PatchLimits) {
    if (await hasHead(cwd)) return diffAgainstRef(cwd, "HEAD", context, limits)
    return diffStatusOnly(cwd, context, limits)
  }

  async function diffAgainstRef(cwd: string, ref: string, context: number, limits: PatchLimits) {
    const [nameStatusRaw, numstatRaw, statusRaw, patchText] = await Promise.all([
      Process.run(["git", "diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", ref, "--", "."], {
        cwd,
        nothrow: true,
      }).then((x) => x.text()),
      Process.run(["git", "diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", ref, "--", "."], {
        cwd,
        nothrow: true,
      }).then((x) => x.text()),
      Process.run(["git", "status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."], {
        cwd,
        env: withoutOptionalLocks(),
        nothrow: true,
      }).then((x) => x.text()),
      patchAll(cwd, ref, context),
    ])
    const tracked = parseNameStatus(nameStatusRaw)
    const untracked = parseStatus(statusRaw).filter((item) => item.untracked)
    const files = mergeStatusEntries(...tracked, ...untracked)
    if (files.length === 0) return []

    const stats = parseNumstat(numstatRaw)
    const { map: batchMap, capped: batchCapped } = buildPatchMap(patchText, tracked, limits)
    return assembleFileDiffs(cwd, ref, files, stats, batchMap, batchCapped, context, limits)
  }

  async function readDefaultBranch(cwd: string) {
    const remotes = (await Process.run(["git", "remote"], { cwd, nothrow: true })).text()
    const remote =
      remotes
        .split("\n")
        .map((item) => item.trim())
        .find((item) => item === "origin") ??
      remotes
        .split("\n")
        .map((item) => item.trim())
        .find(Boolean)
    if (remote) {
      const head = (
        await Process.run(["git", "symbolic-ref", `refs/remotes/${remote}/HEAD`], { cwd, nothrow: true })
      ).text()
      const ref = head.trim().replace(/^refs\/remotes\//, "")
      const name = ref.startsWith(`${remote}/`) ? ref.slice(`${remote}/`.length) : ref
      if (name) return { name, ref }
    }

    const configured = (await Process.run(["git", "config", "init.defaultBranch"], { cwd, nothrow: true })).text()
    const configuredName = configured.trim()
    if (configuredName) return { name: configuredName, ref: configuredName }

    const branches = (
      await Process.run(["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd, nothrow: true })
    ).text()
    const list = branches
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
    if (list.includes("main")) return { name: "main", ref: "main" }
    if (list.includes("master")) return { name: "master", ref: "master" }
  }

  /** Returns the git diff (mode=git: working tree; mode=branch: against the merge-base with the default branch) */
  export async function diff(input: {
    mode: Mode
    context?: number
    /** For tests: overrides the per-file patch limit (bytes) */
    maxPatchBytes?: number
    /** For tests: overrides the total patch limit (bytes) */
    maxTotalPatchBytes?: number
  }): Promise<FileDiff[]> {
    if (Instance.project.vcs !== "git") return []
    if (input.mode === "last-turn") return []

    const cwd = Instance.worktree
    const context = input.context ?? DEFAULT_CONTEXT
    const limits: PatchLimits = {
      maxPatchBytes: input.maxPatchBytes ?? MAX_PATCH_BYTES,
      maxTotalBytes: input.maxTotalPatchBytes ?? MAX_TOTAL_PATCH_BYTES,
    }

    if (input.mode === "branch") {
      const root = await readDefaultBranch(cwd)
      const current = await currentBranch()
      if (!root || (current && current === root.name)) return []
      const mergeBase = (await Process.run(["git", "merge-base", root.ref, "HEAD"], { cwd, nothrow: true })).text()
      const ref = mergeBase.trim()
      if (!ref) return []
      return diffAgainstRef(cwd, ref, context, limits)
    }

    return diffWorkingTree(cwd, context, limits)
  }

  export async function defaultBranch() {
    if (Instance.project.vcs !== "git") return undefined
    return readDefaultBranch(Instance.worktree)
  }

  export const CommitResult = z
    .union([z.object({ ok: z.literal(true), hash: z.string() }), z.object({ ok: z.literal(false), error: z.string() })])
    .meta({ ref: "VcsCommitResult" })
  export type CommitResult = z.infer<typeof CommitResult>

  /**
   * Commits changes. With all=true every change (including new and deleted files) is staged first; otherwise only
   * staged changes are committed. Uses the user's own git identity and hooks; git errors (no identity, hook
   * rejection, ...) are returned as is.
   */
  export async function commit(input: { message: string; all?: boolean }): Promise<CommitResult> {
    if (Instance.project.vcs !== "git") return { ok: false, error: "not a git repository" }
    if (!input.message.trim()) return { ok: false, error: "empty commit message" }
    return Checkout.activity(async () => {
      await state()
      try {
        const cwd = Instance.worktree
        const git = (args: string[]) => Process.run(["git", ...args], { cwd, nothrow: true })
        if (input.all) await git(["add", "-A"])
        // diff --cached --quiet exits with 0 when nothing is staged
        if ((await git(["diff", "--cached", "--quiet"])).exitCode === 0)
          return { ok: false, error: "nothing to commit" }
        const result = await git(["commit", "-m", input.message])
        if (result.exitCode !== 0) return { ok: false, error: (result.stderr.toString() || result.text()).trim() }
        return { ok: true, hash: (await git(["rev-parse", "--short", "HEAD"])).text().trim() }
      } finally {
        await Checkout.current()
      }
    })
  }

  export const PushResult = z
    .union([
      z.object({ ok: z.literal(true), branch: z.string(), remote: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ])
    .meta({ ref: "VcsPushResult" })
  export type PushResult = z.infer<typeof PushResult>

  export const RunResult = z
    .object({
      exitCode: z.number().int(),
      output: z.string(),
    })
    .meta({ ref: "VcsRunResult" })
  export type RunResult = z.infer<typeof RunResult>

  const OUTPUT_LIMIT = 16_000

  function run(args: string[]) {
    return Process.run(["git", ...args], { cwd: Instance.worktree, env: withoutOptionalLocks(), nothrow: true })
  }

  /** Upstream of the current branch (e.g. origin/main), if any */
  async function upstream() {
    const result = await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    return result.exitCode === 0 ? result.text().trim() || undefined : undefined
  }

  /** Remote to push to: the upstream's remote, else origin, else the only remote */
  async function pushRemote(tracking: string | undefined) {
    const remotes = (await run(["remote"]))
      .text()
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
    const fromUpstream = tracking && remotes.find((remote) => tracking.startsWith(`${remote}/`))
    return fromUpstream || (remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined)
  }

  /** porcelain v2 --branch: branch, ahead/behind, and staged / unstaged / untracked file counts */
  function summarize(raw: string) {
    const summary: {
      branch: string
      upstream?: string
      ahead?: number
      behind?: number
      staged: number
      unstaged: number
      untracked: number
    } = { branch: "", staged: 0, unstaged: 0, untracked: 0 }
    for (const entry of raw.split("\n")) {
      const line = entry.replace(/\r$/, "")
      if (line.startsWith("# branch.head ")) {
        const name = line.slice("# branch.head ".length).trim()
        summary.branch = name === "(detached)" ? "HEAD" : name
        continue
      }
      if (line.startsWith("# branch.upstream ")) {
        summary.upstream = line.slice("# branch.upstream ".length).trim()
        continue
      }
      if (line.startsWith("# branch.ab ")) {
        const match = line.match(/\+(\d+) -(\d+)/)
        if (match) {
          summary.ahead = Number(match[1])
          summary.behind = Number(match[2])
        }
        continue
      }
      if (line.startsWith("? ")) {
        summary.untracked++
        continue
      }
      if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
        const index = line[2]
        const worktree = line[3]
        if (index && index !== "." && index !== "?") summary.staged++
        if (worktree && worktree !== "." && worktree !== "?") summary.unstaged++
      }
    }
    return summary
  }

  /** Branch, default branch, push remote, commits ahead of and behind upstream, and change counts */
  export async function status(): Promise<Info | undefined> {
    return (await readStatus())?.info
  }

  async function readStatus() {
    if (Instance.project.vcs !== "git") return undefined
    await state()
    const [porcelain, root, identity] = await Promise.all([
      run(["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--no-renames"]),
      readDefaultBranch(Instance.worktree),
      Checkout.current(),
    ])
    const summary = summarize(porcelain.text())
    const remote = await pushRemote(summary.upstream)
    const info: Info = {
      branch: identity?.branch ?? (identity?.head ? "HEAD" : summary.branch),
      head: identity?.head ?? null,
      checkout: identity?.checkout ?? null,
      staged: summary.staged,
      unstaged: summary.unstaged,
      untracked: summary.untracked,
      ...(root ? { default_branch: root.name } : {}),
      ...(remote ? { remote } : {}),
      ...(summary.ahead !== undefined ? { ahead: summary.ahead, behind: summary.behind ?? 0 } : {}),
    }
    return { identity, info }
  }

  /**
   * Pushes the current branch to its upstream, or to the remote and sets it as upstream. Uses the user's own
   * credentials; git errors are returned as is.
   */
  export async function push(): Promise<PushResult> {
    if (Instance.project.vcs !== "git") return { ok: false, error: "not a git repository" }
    return Checkout.activity(async () => {
      await state()
      try {
        const branch = await currentBranch()
        if (!branch || branch === "HEAD") return { ok: false, error: "not on a branch" }
        const tracking = await upstream()
        const remote = await pushRemote(tracking)
        if (!remote) return { ok: false, error: "no remote" }
        const result = await run(tracking ? ["push"] : ["push", "-u", remote, branch])
        if (result.exitCode !== 0) return { ok: false, error: (result.stderr.toString() || result.text()).trim() }
        log.info("pushed", { branch, remote })
        return { ok: true, branch, remote }
      } finally {
        await Checkout.current()
      }
    })
  }

  /** Runs git with the given arguments in the worktree. Arguments are not passed through a shell. */
  export async function runGit(args: string[]): Promise<RunResult> {
    if (Instance.project.vcs !== "git") return { exitCode: 1, output: "not a git repository" }
    if (args.length === 0 || args.some((arg) => arg.includes("\0"))) return { exitCode: 1, output: "empty command" }
    return Checkout.activity(async () => {
      await state()
      try {
        const result = await run(args)
        const error = result.stderr.toString().trim()
        const output = [result.text().trim(), error].filter(Boolean).join("\n")
        return {
          exitCode: result.exitCode,
          output: output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}\n…` : output,
        }
      } finally {
        await Checkout.current()
      }
    })
  }

  /** Local branches, sorted by name */
  export async function branches() {
    if (Instance.project.vcs !== "git") return []
    const result = await run(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    return result
      .text()
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
      .toSorted()
  }

  export async function branchOptions(): Promise<BranchOptions> {
    await state()
    const [snapshot, names, worktrees, managed, operation] = await Promise.all([
      readStatus(),
      branches(),
      occupiedBranches(),
      managedWorktree(),
      gitOperation(),
    ])
    const identity = snapshot?.identity
    const info = snapshot?.info
    const dirty = info && info.staged + info.unstaged + info.untracked > 0
    const blocked: BranchOptions["blocked"] = (() => {
      if (!identity) return { reason: "not_git" }
      if (!identity.head) return { reason: "unborn" }
      if (managed) return { reason: "managed_worktree" }
      if (Checkout.busy()) return { reason: "busy" }
      if (operation) return { reason: "git_operation", operation }
      if (dirty) return { reason: "dirty", staged: info.staged, unstaged: info.unstaged, untracked: info.untracked }
    })()
    return {
      directory: identity?.directory ?? Instance.directory,
      current: identity ? { branch: identity.branch, head: identity.head, checkout: identity.checkout } : null,
      ...(info?.default_branch ? { defaultBranch: info.default_branch } : {}),
      branches: names.map((name) => {
        const worktree = worktrees.get(name)
        return { name, ...(worktree ? { worktree } : {}) }
      }),
      ...(blocked ? { blocked } : {}),
    }
  }

  export async function switchBranch(input: SwitchInput): Promise<SwitchResult> {
    await state()
    return Checkout.exclusive(async () => {
      const before = await Checkout.assert(input.expectedCheckout)
      if (!before)
        throw new Checkout.BlockedError({ reason: "not_git", message: "The directory is not a Git checkout" })
      if (!before.head)
        throw new Checkout.BlockedError({ reason: "unborn", message: "The checkout needs its first commit" })
      if (before.branch === input.branch && before.head)
        return { branch: input.branch, head: before.head, checkout: before.checkout, changed: false }
      if (await managedWorktree())
        throw new Checkout.BlockedError({
          reason: "managed_worktree",
          message: "The managed worktree is bound to its branch",
        })
      if (!(await branches()).includes(input.branch))
        throw new InvalidBranchError({ branch: input.branch, message: "The local branch does not exist" })
      const operation = await gitOperation()
      if (operation)
        throw new Checkout.BlockedError({
          reason: "git_operation",
          message: "The checkout has an unfinished Git operation",
          operation,
        })
      const info = await status()
      if (info && info.staged + info.unstaged + info.untracked > 0)
        throw new Checkout.BlockedError({
          reason: "dirty",
          message: "The checkout has uncommitted changes",
          staged: info.staged,
          unstaged: info.unstaged,
          untracked: info.untracked,
        })
      const occupied = (await occupiedBranches()).get(input.branch)
      if (occupied)
        throw new Checkout.BlockedError({
          reason: "occupied",
          message: "The branch is already used by another worktree",
          branch: input.branch,
          worktree: occupied,
        })
      await Checkout.assert(input.expectedCheckout)
      const result = await run(["switch", "--no-guess", "--", input.branch])
      if (result.exitCode !== 0)
        throw new SwitchFailedError({ message: (result.stderr.toString() || result.text()).trim() })
      const after = await Checkout.current()
      if (!after?.head || after.branch !== input.branch)
        throw new SwitchFailedError({ message: "The checkout does not match the selected branch" })
      return { branch: after.branch, head: after.head, checkout: after.checkout, changed: true }
    })
  }

  async function managedWorktree() {
    const directories = await Project.sandboxes(Instance.project.id)
    return directories.some((directory) => Checkout.sameDirectory(directory, Instance.worktree))
  }

  async function gitOperation() {
    const result = await run(["rev-parse", "--git-dir"])
    if (result.exitCode !== 0) return undefined
    const directory = path.resolve(Instance.worktree, result.text().trim())
    const markers = [
      ["rebase-merge", "rebase"],
      ["rebase-apply", "rebase"],
      ["MERGE_HEAD", "merge"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
      ["BISECT_LOG", "bisect"],
      ["sequencer", "sequencer"],
    ] as const
    const active = await Promise.all(
      markers.map(async ([marker, operation]) =>
        (await stat(path.join(directory, marker)).catch(() => undefined)) ? operation : undefined,
      ),
    )
    return active.find(Boolean)
  }

  async function occupiedBranches() {
    const result = await run(["worktree", "list", "--porcelain", "-z"])
    const occupied = new Map<string, string>()
    let directory: string | undefined
    for (const field of result.text().split("\0")) {
      if (field.startsWith("worktree ")) directory = path.resolve(field.slice("worktree ".length))
      if (!field.startsWith("branch refs/heads/") || !directory || Checkout.sameDirectory(directory, Instance.worktree))
        continue
      occupied.set(field.slice("branch refs/heads/".length), directory)
    }
    return occupied
  }

  async function currentBranch() {
    return Process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: Instance.worktree, nothrow: true })
      .then((x) => x.text().trim())
      .catch(() => undefined)
  }

  const state = Instance.state(
    async () => {
      if (Instance.project.vcs !== "git") {
        return { branch: async () => undefined, unsubscribe: undefined }
      }
      let current = await Checkout.current()
      log.info("initialized", { branch: current?.branch })
      const release = Checkout.subscribe((next, previous) => {
        current = next
        const branchChanged = next?.branch !== previous?.branch
        if (branchChanged)
          Bus.publish(Event.BranchUpdated, { branch: next?.branch ?? (next?.head ? "HEAD" : undefined) })
        Bus.publish(Event.HeadUpdated, {
          branch: next?.branch ?? null,
          head: next?.head ?? null,
          checkout: next?.checkout ?? null,
          branchChanged,
        })
      })
      let refresh: ReturnType<typeof setTimeout> | undefined
      const unwatch = Bus.subscribe(FileWatcher.Event.Updated, (evt) => {
        const file = evt.properties.file.replace(/\\/g, "/")
        if (!file.endsWith("/HEAD") && !file.endsWith("/packed-refs") && !file.includes("/refs/")) return
        clearTimeout(refresh)
        refresh = setTimeout(() => {
          void Checkout.current().catch((error) => log.error("checkout refresh failed", { error }))
        }, 25)
        refresh.unref?.()
      })

      return {
        branch: async () => current?.branch ?? (current?.head ? "HEAD" : undefined),
        unsubscribe: () => {
          clearTimeout(refresh)
          release()
          unwatch()
        },
      }
    },
    async (state) => {
      state.unsubscribe?.()
    },
  )

  export async function init() {
    return state()
  }

  export async function branch() {
    return await state().then((s) => s.branch())
  }
}
