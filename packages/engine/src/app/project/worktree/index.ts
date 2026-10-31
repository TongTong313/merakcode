import { discoverProject } from "@merakcode/engine/app/project/discover"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { NamedError } from "@merakcode/util/error"
import { Process } from "@merakcode/util/process"
import { Global } from "../../../infra/global"
import { Instance } from "../../../infra/project/instance"
import { InstanceBootstrap } from "../bootstrap"
import { Project } from "../../../infra/project/project"
import { Storage } from "../../../infra/storage/storage"
import { fn } from "@merakcode/util/fn"
import { Log } from "@merakcode/log/logger"
import { BusEvent } from "../../../infra/bus/bus-event"
import { GlobalBus } from "../../../infra/bus/global"
import { Message } from "../../../agent/session/message"
import { Checkout } from "../../../infra/project/checkout"
import { defer } from "@merakcode/util/defer"

export namespace Worktree {
  const log = Log.create({ service: "worktree" })

  export const Event = {
    Ready: BusEvent.define(
      "worktree.ready",
      z.object({
        name: z.string(),
        branch: z.string(),
      }),
    ),
    Failed: BusEvent.define(
      "worktree.failed",
      z.object({
        message: z.string(),
      }),
    ),
  }

  export const Info = z
    .object({
      name: z.string(),
      branch: z.string(),
      directory: z.string(),
    })
    .meta({
      ref: "Worktree",
    })

  export type Info = z.infer<typeof Info>

  export const CreateInput = z
    .object({
      name: z.string().optional(),
      base: z.string().optional().describe("Branch or commit to start the worktree from; defaults to the current HEAD"),
      startCommand: z
        .string()
        .optional()
        .describe("Additional startup script to run after the project's start command"),
    })
    .meta({
      ref: "WorktreeCreateInput",
    })

  export type CreateInput = z.infer<typeof CreateInput>

  export const RemoveInput = z
    .object({
      directory: z.string(),
    })
    .meta({
      ref: "WorktreeRemoveInput",
    })

  export type RemoveInput = z.infer<typeof RemoveInput>

  export const ResetInput = z
    .object({
      directory: z.string(),
    })
    .meta({
      ref: "WorktreeResetInput",
    })

  export type ResetInput = z.infer<typeof ResetInput>

  export const MergeInput = z
    .object({
      directory: z.string(),
      squash: z.boolean().optional().describe("Squash the worktree branch into a single commit"),
      message: z
        .string()
        .optional()
        .describe("Commit message for uncommitted changes in the worktree and for the merge or squash commit"),
    })
    .meta({
      ref: "WorktreeMergeInput",
    })

  export type MergeInput = z.infer<typeof MergeInput>

  export const MergeResult = z
    .union([
      z.object({ ok: z.literal(true), commit: z.string() }),
      z.object({ ok: z.literal(false), reason: z.literal("conflict"), files: z.string().array() }),
      z.object({ ok: z.literal(false), reason: z.literal("failed"), message: z.string() }),
    ])
    .meta({
      ref: "WorktreeMergeResult",
    })

  export type MergeResult = z.infer<typeof MergeResult>

  export const NotGitError = NamedError.create(
    "WorktreeNotGitError",
    z.object({
      message: z.string(),
    }),
  )

  export const NameGenerationFailedError = NamedError.create(
    "WorktreeNameGenerationFailedError",
    z.object({
      message: z.string(),
    }),
  )

  export const CreateFailedError = NamedError.create(
    "WorktreeCreateFailedError",
    z.object({
      message: z.string(),
    }),
  )

  export const StartCommandFailedError = NamedError.create(
    "WorktreeStartCommandFailedError",
    z.object({
      message: z.string(),
    }),
  )

  export const RemoveFailedError = NamedError.create(
    "WorktreeRemoveFailedError",
    z.object({
      message: z.string(),
    }),
  )

  export const ResetFailedError = NamedError.create(
    "WorktreeResetFailedError",
    z.object({
      message: z.string(),
    }),
  )

  const ADJECTIVES = [
    "brave",
    "calm",
    "clever",
    "cosmic",
    "crisp",
    "curious",
    "eager",
    "gentle",
    "glowing",
    "happy",
    "hidden",
    "jolly",
    "kind",
    "lucky",
    "mighty",
    "misty",
    "neon",
    "nimble",
    "playful",
    "proud",
    "quick",
    "quiet",
    "shiny",
    "silent",
    "stellar",
    "sunny",
    "swift",
    "tidy",
    "witty",
  ] as const

  const NOUNS = [
    "cabin",
    "cactus",
    "canyon",
    "circuit",
    "comet",
    "eagle",
    "engine",
    "falcon",
    "forest",
    "garden",
    "harbor",
    "island",
    "knight",
    "lagoon",
    "meadow",
    "moon",
    "mountain",
    "nebula",
    "orchid",
    "otter",
    "panda",
    "pixel",
    "planet",
    "river",
    "rocket",
    "sailor",
    "squid",
    "star",
    "tiger",
    "wizard",
    "wolf",
  ] as const

  function pick<const T extends readonly string[]>(list: T) {
    return list[Math.floor(Math.random() * list.length)]
  }

  function slug(input: string) {
    return input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
  }

  function randomName() {
    return `${pick(ADJECTIVES)}-${pick(NOUNS)}`
  }

  async function exists(target: string) {
    return fs
      .stat(target)
      .then(() => true)
      .catch(() => false)
  }

  function outputText(input: Uint8Array | undefined) {
    if (!input?.length) return ""
    return new TextDecoder().decode(input).trim()
  }

  function errorText(result: { stdout?: Uint8Array; stderr?: Uint8Array }) {
    return [outputText(result.stderr), outputText(result.stdout)].filter(Boolean).join("\n")
  }

  function failed(result: { stdout?: Uint8Array; stderr?: Uint8Array }) {
    return [outputText(result.stderr), outputText(result.stdout)].filter(Boolean).flatMap((chunk) =>
      chunk
        .split("\n")
        .map((line) => line.trim())
        .flatMap((line) => {
          const match = line.match(/^warning:\s+failed to remove\s+(.+):\s+/i)
          if (!match) return []
          const value = match[1]?.trim().replace(/^['"]|['"]$/g, "")
          if (!value) return []
          return [value]
        }),
    )
  }

  async function prune(root: string, entries: string[]) {
    const base = await canonical(root)
    await Promise.all(
      entries.map(async (entry) => {
        const target = await canonical(path.resolve(root, entry))
        if (target === base) return
        if (!target.startsWith(`${base}${path.sep}`)) return
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
      }),
    )
  }

  async function sweep(root: string) {
    const first = await Process.run(["git", "clean", "-ffdx"], { cwd: root, nothrow: true })
    if (first.exitCode === 0) return first

    const entries = failed(first)
    if (!entries.length) return first

    await prune(root, entries)
    return Process.run(["git", "clean", "-ffdx"], { cwd: root, nothrow: true })
  }

  async function canonical(input: string) {
    const abs = path.resolve(input)
    const real = await fs.realpath(abs).catch(() => abs)
    const normalized = path.normalize(real)
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
  }

  async function candidate(root: string, base?: string) {
    for (const attempt of Array.from({ length: 26 }, (_, i) => i)) {
      const name = base ? (attempt === 0 ? base : `${base}-${randomName()}`) : randomName()
      const branch = `merakcode/${name}`
      const directory = path.join(root, name)

      if (await exists(directory)) continue

      const ref = `refs/heads/${branch}`
      const branchCheck = await Process.run(["git", "show-ref", "--verify", "--quiet", ref], {
        cwd: Instance.worktree,
        nothrow: true,
      })
      if (branchCheck.exitCode === 0) continue

      return Info.parse({ name, branch, directory })
    }

    throw new NameGenerationFailedError({ message: "Failed to generate a unique worktree name" })
  }

  async function runStartCommand(directory: string, cmd: string) {
    if (process.platform === "win32") {
      return Process.run(["cmd", "/c", cmd], { cwd: directory, nothrow: true })
    }
    return Process.run(["bash", "-lc", cmd], { cwd: directory, nothrow: true })
  }

  type StartKind = "project" | "worktree"

  async function runStartScript(directory: string, cmd: string, kind: StartKind) {
    const text = cmd.trim()
    if (!text) return true

    const ran = await runStartCommand(directory, text)
    if (ran.exitCode === 0) return true

    log.error("worktree start command failed", {
      kind,
      directory,
      message: errorText(ran),
    })
    return false
  }

  async function runStartScripts(directory: string, input: { projectID: string; extra?: string }) {
    const project = await Storage.read<Project.Info>(["project", input.projectID]).catch(() => undefined)
    const startup = project?.commands?.start?.trim() ?? ""
    const ok = await runStartScript(directory, startup, "project")
    if (!ok) return false

    const extra = input.extra ?? ""
    await runStartScript(directory, extra, "worktree")
    return true
  }

  function queueStartScripts(directory: string, input: { projectID: string; extra?: string }) {
    setTimeout(() => {
      const start = async () => {
        await runStartScripts(directory, input)
      }

      void start().catch((error) => {
        log.error("worktree start task failed", { directory, error })
      })
    }, 0)
  }

  export const create = fn(CreateInput.optional(), async (input) => {
    // Like Cursor: worktrees rely on a single git root, so they are unavailable in multi-root workspaces
    if (Instance.workspace.folders.length > 1) {
      throw new NotGitError({
        message: "Worktrees are disabled in multi-root workspaces; open a single-folder workspace instead",
      })
    }
    if (Instance.project.vcs !== "git") {
      throw new NotGitError({ message: "Worktrees are only supported for git projects" })
    }

    const root = path.join(Global.Path.worktrees, Instance.project.id)
    await fs.mkdir(root, { recursive: true })

    const base = input?.name ? slug(input.name) : ""
    const info = await candidate(root, base || undefined)

    const created = await Process.run(
      [
        "git",
        "worktree",
        "add",
        "--no-checkout",
        "-b",
        info.branch,
        info.directory,
        ...(input?.base ? [input.base] : []),
      ],
      {
        cwd: Instance.worktree,
        nothrow: true,
      },
    )
    if (created.exitCode !== 0) {
      throw new CreateFailedError({ message: errorText(created) || "Failed to create git worktree" })
    }

    await Project.addSandbox(Instance.project.id, info.directory).catch(() => undefined)

    const projectID = Instance.project.id
    const extra = input?.startCommand?.trim()
    setTimeout(() => {
      const start = async () => {
        const populated = await Process.run(["git", "reset", "--hard"], { cwd: info.directory, nothrow: true })
        if (populated.exitCode !== 0) {
          const message = errorText(populated) || "Failed to populate worktree"
          log.error("worktree checkout failed", { directory: info.directory, message })
          GlobalBus.emit("event", {
            directory: info.directory,
            payload: {
              type: Event.Failed.type,
              properties: {
                message,
              },
            },
          })
          return
        }

        const booted = await Instance.provide({
          resolveProject: discoverProject,
          directory: info.directory,
          init: InstanceBootstrap,
          fn: () => undefined,
        })
          .then(() => true)
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            log.error("worktree bootstrap failed", { directory: info.directory, message })
            GlobalBus.emit("event", {
              directory: info.directory,
              payload: {
                type: Event.Failed.type,
                properties: {
                  message,
                },
              },
            })
            return false
          })
        if (!booted) return

        GlobalBus.emit("event", {
          directory: info.directory,
          payload: {
            type: Event.Ready.type,
            properties: {
              name: info.name,
              branch: info.branch,
            },
          },
        })

        await runStartScripts(info.directory, { projectID, extra })
      }

      void start().catch((error) => {
        log.error("worktree start task failed", { directory: info.directory, error })
      })
    }, 0)

    return info
  })

  export const remove = fn(RemoveInput, async (input) => {
    const releaseCheckout = Checkout.hold(input.directory)
    await using _ = defer(async () => {
      try {
        await Checkout.current(input.directory)
      } finally {
        releaseCheckout()
      }
    })
    if (Instance.project.vcs !== "git") {
      throw new NotGitError({ message: "Worktrees are only supported for git projects" })
    }

    const directory = await canonical(input.directory)
    const locate = async (stdout: Uint8Array | undefined) => {
      const lines = outputText(stdout)
        .split("\n")
        .map((line) => line.trim())
      const entries = lines.reduce<{ path?: string; branch?: string }[]>((acc, line) => {
        if (!line) return acc
        if (line.startsWith("worktree ")) {
          acc.push({ path: line.slice("worktree ".length).trim() })
          return acc
        }
        const current = acc[acc.length - 1]
        if (!current) return acc
        if (line.startsWith("branch ")) {
          current.branch = line.slice("branch ".length).trim()
        }
        return acc
      }, [])

      return (async () => {
        for (const item of entries) {
          if (!item.path) continue
          const key = await canonical(item.path)
          if (key === directory) return item
        }
      })()
    }

    const clean = (target: string) =>
      fs
        .rm(target, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          throw new RemoveFailedError({ message: message || "Failed to remove git worktree directory" })
        })

    const list = await Process.run(["git", "worktree", "list", "--porcelain"], {
      cwd: Instance.worktree,
      nothrow: true,
    })
    if (list.exitCode !== 0) {
      throw new RemoveFailedError({ message: errorText(list) || "Failed to read git worktrees" })
    }

    const entry = await locate(list.stdout)

    if (!entry?.path) {
      const directoryExists = await exists(directory)
      if (directoryExists) {
        await clean(directory)
      }
      return true
    }

    const removed = await Process.run(["git", "worktree", "remove", "--force", entry.path], {
      cwd: Instance.worktree,
      nothrow: true,
    })
    if (removed.exitCode !== 0) {
      const next = await Process.run(["git", "worktree", "list", "--porcelain"], {
        cwd: Instance.worktree,
        nothrow: true,
      })
      if (next.exitCode !== 0) {
        throw new RemoveFailedError({
          message: errorText(removed) || errorText(next) || "Failed to remove git worktree",
        })
      }

      const stale = await locate(next.stdout)
      if (stale?.path) {
        throw new RemoveFailedError({ message: errorText(removed) || "Failed to remove git worktree" })
      }
    }

    await clean(entry.path)

    const branch = entry.branch?.replace(/^refs\/heads\//, "")
    if (branch) {
      const deleted = await Process.run(["git", "branch", "-D", branch], { cwd: Instance.worktree, nothrow: true })
      if (deleted.exitCode !== 0) {
        throw new RemoveFailedError({ message: errorText(deleted) || "Failed to delete worktree branch" })
      }
    }

    return true
  })

  export const reset = fn(ResetInput, async (input) => {
    const releaseCheckout = Checkout.hold(input.directory)
    await using _ = defer(async () => {
      try {
        await Checkout.current(input.directory)
      } finally {
        releaseCheckout()
      }
    })
    if (Instance.project.vcs !== "git") {
      throw new NotGitError({ message: "Worktrees are only supported for git projects" })
    }

    const directory = await canonical(input.directory)
    const primary = await canonical(Instance.worktree)
    if (directory === primary) {
      throw new ResetFailedError({ message: "Cannot reset the primary workspace" })
    }

    const list = await Process.run(["git", "worktree", "list", "--porcelain"], {
      cwd: Instance.worktree,
      nothrow: true,
    })
    if (list.exitCode !== 0) {
      throw new ResetFailedError({ message: errorText(list) || "Failed to read git worktrees" })
    }

    const lines = outputText(list.stdout)
      .split("\n")
      .map((line) => line.trim())
    const entries = lines.reduce<{ path?: string; branch?: string }[]>((acc, line) => {
      if (!line) return acc
      if (line.startsWith("worktree ")) {
        acc.push({ path: line.slice("worktree ".length).trim() })
        return acc
      }
      const current = acc[acc.length - 1]
      if (!current) return acc
      if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).trim()
      }
      return acc
    }, [])

    const entry = await (async () => {
      for (const item of entries) {
        if (!item.path) continue
        const key = await canonical(item.path)
        if (key === directory) return item
      }
    })()
    if (!entry?.path) {
      throw new ResetFailedError({ message: "Worktree not found" })
    }

    const remoteList = await Process.run(["git", "remote"], { cwd: Instance.worktree, nothrow: true })
    if (remoteList.exitCode !== 0) {
      throw new ResetFailedError({ message: errorText(remoteList) || "Failed to list git remotes" })
    }

    const remotes = outputText(remoteList.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)

    const remote = remotes.includes("origin")
      ? "origin"
      : remotes.length === 1
        ? remotes[0]
        : remotes.includes("upstream")
          ? "upstream"
          : ""

    const remoteHead = remote
      ? await Process.run(["git", "symbolic-ref", `refs/remotes/${remote}/HEAD`], {
          cwd: Instance.worktree,
          nothrow: true,
        })
      : { exitCode: 1, stdout: undefined, stderr: undefined }

    const remoteRef = remoteHead.exitCode === 0 ? outputText(remoteHead.stdout) : ""
    const remoteTarget = remoteRef ? remoteRef.replace(/^refs\/remotes\//, "") : ""
    const remoteBranch = remote && remoteTarget.startsWith(`${remote}/`) ? remoteTarget.slice(`${remote}/`.length) : ""

    const mainCheck = await Process.run(["git", "show-ref", "--verify", "--quiet", "refs/heads/main"], {
      cwd: Instance.worktree,
      nothrow: true,
    })
    const masterCheck = await Process.run(["git", "show-ref", "--verify", "--quiet", "refs/heads/master"], {
      cwd: Instance.worktree,
      nothrow: true,
    })
    const localBranch = mainCheck.exitCode === 0 ? "main" : masterCheck.exitCode === 0 ? "master" : ""

    const target = remoteBranch ? `${remote}/${remoteBranch}` : localBranch
    if (!target) {
      throw new ResetFailedError({ message: "Default branch not found" })
    }

    if (remoteBranch) {
      const fetch = await Process.run(["git", "fetch", remote, remoteBranch], { cwd: Instance.worktree, nothrow: true })
      if (fetch.exitCode !== 0) {
        throw new ResetFailedError({ message: errorText(fetch) || `Failed to fetch ${target}` })
      }
    }

    if (!entry.path) {
      throw new ResetFailedError({ message: "Worktree path not found" })
    }

    const worktreePath = entry.path

    const resetToTarget = await Process.run(["git", "reset", "--hard", target], { cwd: worktreePath, nothrow: true })
    if (resetToTarget.exitCode !== 0) {
      throw new ResetFailedError({ message: errorText(resetToTarget) || "Failed to reset worktree to target" })
    }

    const clean = await sweep(worktreePath)
    if (clean.exitCode !== 0) {
      throw new ResetFailedError({ message: errorText(clean) || "Failed to clean worktree" })
    }

    const update = await Process.run(["git", "submodule", "update", "--init", "--recursive", "--force"], {
      cwd: worktreePath,
      nothrow: true,
    })
    if (update.exitCode !== 0) {
      throw new ResetFailedError({ message: errorText(update) || "Failed to update submodules" })
    }

    const subReset = await Process.run(["git", "submodule", "foreach", "--recursive", "git", "reset", "--hard"], {
      cwd: worktreePath,
      nothrow: true,
    })
    if (subReset.exitCode !== 0) {
      throw new ResetFailedError({ message: errorText(subReset) || "Failed to reset submodules" })
    }

    const subClean = await Process.run(["git", "submodule", "foreach", "--recursive", "git", "clean", "-fdx"], {
      cwd: worktreePath,
      nothrow: true,
    })
    if (subClean.exitCode !== 0) {
      throw new ResetFailedError({ message: errorText(subClean) || "Failed to clean submodules" })
    }

    const status = await Process.run(["git", "status", "--porcelain=v1"], { cwd: worktreePath, nothrow: true })
    if (status.exitCode !== 0) {
      throw new ResetFailedError({ message: errorText(status) || "Failed to read git status" })
    }

    const dirty = outputText(status.stdout)
    if (dirty) {
      throw new Message.WorktreeResetDirtyError({
        dirty,
        messageKey: "error.worktreeResetDirty",
        params: { dirty },
        message: `Worktree reset left local changes:\n${dirty}`,
      })
    }

    const projectID = Instance.project.id
    queueStartScripts(worktreePath, { projectID })

    return true
  })

  /**
   * Merges a worktree's branch into the current branch of the primary workspace. Uncommitted changes in the worktree
   * are committed to its branch first. On conflict the merge is aborted, the conflicting files are returned and the
   * primary workspace is restored (the user can have the agent merge the main branch into the worktree and resolve
   * the conflicts there first).
   */
  export const merge = fn(MergeInput, async (input): Promise<MergeResult> => {
    using _primaryCheckout = defer(Checkout.hold())
    const releaseSource = Checkout.hold(input.directory)
    await using _sourceCheckout = defer(async () => {
      try {
        await Promise.all([Checkout.current(), Checkout.current(input.directory)])
      } finally {
        releaseSource()
      }
    })
    if (Instance.project.vcs !== "git") {
      throw new NotGitError({ message: "Worktrees are only supported for git projects" })
    }
    const git = (cwd: string, args: string[]) => Process.run(["git", ...args], { cwd, nothrow: true })
    const primary = Instance.worktree
    const fail = (message: string): MergeResult => ({ ok: false, reason: "failed", message })

    const list = await git(primary, ["worktree", "list", "--porcelain"])
    if (list.exitCode !== 0) return fail(errorText(list) || "Failed to read git worktrees")
    const directory = await canonical(input.directory)
    const blocks = outputText(list.stdout).split(/\n\s*\n/)
    const entry = await (async () => {
      for (const block of blocks) {
        const worktree = /^worktree (.+)$/m.exec(block)?.[1]?.trim()
        const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim()
        if (worktree && branch && (await canonical(worktree)) === directory) return { path: worktree, branch }
      }
    })()
    if (!entry) return fail("Worktree not found")
    if ((await canonical(entry.path)) === (await canonical(primary))) return fail("Cannot merge the primary workspace")

    const message = input.message?.trim() || `Merge ${entry.branch}`
    if (outputText((await git(entry.path, ["status", "--porcelain"])).stdout)) {
      await git(entry.path, ["add", "-A"])
      const committed = await git(entry.path, ["commit", "-m", message])
      if (committed.exitCode !== 0) return fail(errorText(committed) || "Failed to commit worktree changes")
    }

    const merged = await git(
      primary,
      input.squash ? ["merge", "--squash", entry.branch] : ["merge", "--no-ff", "-m", message, entry.branch],
    )
    // A squash has no MERGE_HEAD, so merge --abort fails; reset --merge undoes both kinds and keeps unrelated local
    // changes
    const undo = () => git(primary, ["reset", "--merge"])
    if (merged.exitCode !== 0) {
      const conflicts = outputText((await git(primary, ["diff", "--name-only", "--diff-filter=U", "-z"])).stdout)
        .split("\0")
        .filter(Boolean)
      if (conflicts.length || !input.squash) await undo()
      log.info("worktree merge failed", { branch: entry.branch, conflicts: conflicts.length })
      if (conflicts.length) return { ok: false, reason: "conflict", files: conflicts }
      return fail(errorText(merged) || "Failed to merge worktree")
    }
    // A squash only stages the changes: commit only if something is staged (nothing is when already merged)
    if (input.squash && (await git(primary, ["diff", "--cached", "--quiet"])).exitCode !== 0) {
      const committed = await git(primary, ["commit", "-m", message])
      if (committed.exitCode !== 0) {
        await undo()
        return fail(errorText(committed) || "Failed to commit the squashed changes")
      }
    }
    log.info("worktree merged", { branch: entry.branch, squash: !!input.squash })
    return { ok: true, commit: outputText((await git(primary, ["rev-parse", "--short", "HEAD"])).stdout) }
  })
}
