import { Slug } from "@merakcode/util/slug"
import { NamedError } from "@merakcode/util/error"
import path from "path"
import fs from "fs/promises"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import { Decimal } from "decimal.js"
import z from "zod"
import { type LanguageModelUsage, type ProviderMetadata } from "ai"
import { Identifier } from "@merakcode/util/id"
import { Installation } from "../installation"

import { Storage } from "../storage/storage"
import { Log } from "@merakcode/log/logger"
import { Message } from "./message"
import { Transcript } from "./transcript"
import { Instance } from "../project/instance"
import { SessionRunner } from "./runner"
import { SessionDispatch } from "./dispatch"
import { fn } from "../util/fn"
import { Command } from "../command"
import { Snapshot } from "../snapshot"

import type { Provider } from "../provider/provider"
import { PermissionNext } from "../permission/next"
import { PermissionMode } from "../permission/mode"
import { Global } from "../global"
import { failure } from "@merakcode/log"
import { SessionTitle } from "@merakcode/util/session-title"

export namespace Session {
  const log = Log.create({ service: "session" })

  export const ReadError = NamedError.create(
    "SessionReadError",
    z.object({
      sessionID: z.string(),
      reason: z.enum(["invalid_json", "invalid_data", "io"]),
      message: z.string(),
    }),
  )

  const createDefaultTitle = SessionTitle.create
  export const isDefaultTitle = SessionTitle.isDefault

  function getForkedTitle(title: string): string {
    const match = title.match(/^(.+) \(fork #(\d+)\)$/)
    if (match) {
      const base = match[1]
      const num = parseInt(match[2], 10)
      return `${base} (fork #${num + 1})`
    }
    return `${title} (fork #1)`
  }

  export const Info = z
    .object({
      id: Identifier.schema("session"),
      slug: z.string(),
      projectID: z.string(),
      directory: z.string(),
      /** Snapshot of multi-root workspace folders; optional for a single root. Instance.workspace is authoritative */
      workspaceFolders: z
        .array(
          z.object({
            name: z.string(),
            path: z.string(),
          }),
        )
        .optional(),
      parentID: Identifier.schema("session").optional(),
      summary: z
        .object({
          additions: z.number(),
          deletions: z.number(),
          files: z.number(),
          diffs: Snapshot.FileDiff.array().optional(),
        })
        .optional(),
      title: z.string(),
      version: z.string(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        compacting: z.number().optional(),
        archived: z.number().optional(),
      }),
      permission: PermissionNext.Ruleset.optional(),
      // Session permission mode (read-only, ask, auto); this is the source of truth. It is written back with each user
      // message and can change mid-run via setPermissionMode. The runner recomputes the ruleset before each tool call,
      // so a switch takes effect immediately. Child sessions follow the root session (SessionRunner.modeOf).
      permissionMode: PermissionMode.Schema.optional(),
      undoRedo: z
        .object({
          stack: z.array(
            z.object({
              hiddenMessages: z.string().array(),
              fileSnapshot: z.string(),
              targetMessageID: z.string(),
              timestamp: z.number(),
            }),
          ),
        })
        .optional(),
      revert: z
        .object({
          messageID: z.string(),
          partID: z.string().optional(),
          snapshot: z.string().optional(),
          diff: z.string().optional(),
        })
        .optional(),
      /**
       * Rule state for the session: pinned manual/intelligent rules and the recent-file ledger used by glob rules.
       * Child sessions do not inherit it; a sibling fork copies only pinned.
       */
      rules: z
        .object({
          pinned: z
            .array(
              z.object({
                filepath: z.string(),
                source: z.enum(["mention", "fetch"]),
              }),
            )
            .optional(),
          recentFiles: z
            .array(
              z.object({
                path: z.string(),
                userMessageID: z.string(),
              }),
            )
            .optional(),
          userTurns: z.array(z.string()).optional(),
        })
        .optional(),
      /**
       * Free-form metadata for clients and plugins: set on create and replaced as a whole on update.
       * The engine does not interpret it and never relaxes permissions or moderation based on it.
       */
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .meta({
      ref: "Session",
    })
  export type Info = z.output<typeof Info>

  export const Event = {
    // `sessionID` always equals `info.id`. It exists for opencode 1.16.2 compatibility: its session.created/updated/
    // deleted and message.updated events carry this top-level field (see types.gen.d.ts in @opencode-ai/sdk), so
    // subscribers written for opencode can read `event.properties.sessionID` unchanged. It is **required** so a
    // publisher that omits it fails typecheck instead of a subscriber reading undefined.
    Created: BusEvent.define(
      "session.created",
      z.object({
        sessionID: z.string(),
        info: Info,
      }),
    ),
    Updated: BusEvent.define(
      "session.updated",
      z.object({
        sessionID: z.string(),
        info: Info,
      }),
    ),
    Deleted: BusEvent.define(
      "session.deleted",
      z.object({
        sessionID: z.string(),
        info: Info,
      }),
    ),
    Diff: BusEvent.define(
      "session.diff",
      z.object({
        sessionID: z.string(),
        diff: Snapshot.FileDiff.array(),
      }),
    ),
    Error: BusEvent.define(
      "session.error",
      z.object({
        sessionID: z.string().optional(),
        error: Message.AssistantInfo.shape.error,
      }),
    ),
  }

  export const create = fn(
    z
      .object({
        parentID: Identifier.schema("session").optional(),
        title: z.string().optional(),
        permission: Info.shape.permission,
        metadata: Info.shape.metadata,
      })
      .optional(),
    async (input) => {
      return createNext({
        parentID: input?.parentID,
        directory: Instance.directory,
        title: input?.title,
        permission: input?.permission,
        metadata: input?.metadata,
      })
    },
  )

  // Copies messages from a source session into a new session. Private; used only by fork (sibling session) and
  // forkAsChild (child session).
  //
  // What is copied:
  // - by default, every message of the source session, oldest first
  // - with messageID, only messages with id < messageID (excluding messageID itself)
  // - with filterCompacted, only messages after the latest compaction (so a forked subagent inherits the effective
  //   context of the main session)
  async function forkInto(input: {
    sessionID: string
    messageID?: string
    parentID?: string
    title: string
    permission?: PermissionNext.Ruleset
    filterCompacted?: boolean
  }): Promise<Info> {
    const original = await get(input.sessionID)
    if (!original) throw new Error("session not found")
    let session = await createNext({
      directory: Instance.directory,
      title: input.title,
      parentID: input.parentID,
      permission: input.permission,
    })

    // A sibling fork continues the same conversation, so it copies pins. Child sessions (with parentID) do not.
    if (!input.parentID && original.rules?.pinned?.length) {
      session = await update(
        session.id,
        (draft) => {
          draft.rules = {
            ...draft.rules,
            pinned: original.rules!.pinned!.map((item) => ({ ...item })),
          }
        },
        { touch: false },
      )
    }

    // Source messages, oldest first
    const msgs = input.filterCompacted
      ? await Message.filterCompacted(Message.stream(input.sessionID))
      : await messages({ sessionID: input.sessionID })

    const idMap = new Map<string, string>()
    // If mapping fails, the source parentID must not leak through ...msg.info; client groupTurns would not match the
    // reply and it would look lost
    let lastUserID: string | undefined

    for (const msg of msgs) {
      if (input.messageID && msg.info.id >= input.messageID) break

      let parentID: string | undefined
      if (msg.info.role === "assistant") {
        parentID = (msg.info.parentID ? idMap.get(msg.info.parentID) : undefined) ?? lastUserID
        if (!parentID) continue
      }

      const newID = Identifier.ascending("message")
      idMap.set(msg.info.id, newID)
      const partIDMap = new Map(msg.parts.map((part) => [part.id, Identifier.ascending("part")]))
      const commandSource = msg.info.role === "user" ? msg.info.commandSource : undefined
      const cloned = await updateInfo({
        ...msg.info,
        sessionID: session.id,
        id: newID,
        ...(msg.info.role === "user" && commandSource
          ? {
              commandSource: {
                templatePartIDs: commandSource.templatePartIDs.flatMap((id) => {
                  const mapped = partIDMap.get(id)
                  return mapped ? [mapped] : []
                }),
              },
            }
          : {}),
        ...(msg.info.role === "assistant" ? { parentID } : {}),
      } as Message.Info)
      if (msg.info.role === "user") lastUserID = newID

      for (const part of msg.parts) {
        await updatePart({
          ...part,
          id: partIDMap.get(part.id)!,
          messageID: cloned.id,
          sessionID: session.id,
        })
      }
    }
    return session
  }

  // Creates a sibling session (no parentID, title suffixed with "(fork #N)") with all source messages, cut at
  // messageID if given
  export const fork = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
    }),
    async (input) => {
      const original = await get(input.sessionID)
      if (!original) throw new Error("session not found")
      return forkInto({
        sessionID: input.sessionID,
        messageID: input.messageID,
        title: getForkedTitle(original.title),
      })
    },
  )

  // Creates a child session (with parentID and custom permission). Only messages after the latest compaction are
  // copied to keep token cost bounded. Used only by SubAgentTool with mode: "fork".
  export const forkAsChild = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
      parentID: Identifier.schema("session"),
      title: z.string(),
      permission: PermissionNext.Ruleset.optional(),
    }),
    async (input) =>
      forkInto({
        sessionID: input.sessionID,
        messageID: input.messageID,
        parentID: input.parentID,
        title: input.title,
        permission: input.permission,
        filterCompacted: true,
      }),
  )

  export const touch = fn(Identifier.schema("session"), async (sessionID) => {
    await update(sessionID, (draft) => {
      draft.time.updated = Date.now()
    })
  })

  export async function createNext(input: {
    id?: string
    title?: string
    parentID?: string
    directory: string
    permission?: PermissionNext.Ruleset
    metadata?: Info["metadata"]
  }) {
    const workspaceFolders =
      Instance.workspace.folders.length > 1
        ? Instance.workspace.folders.map((f) => ({ name: f.name, path: f.path }))
        : undefined
    const result: Info = {
      id: Identifier.descending("session", input.id),
      slug: Slug.create(),
      version: Installation.VERSION,
      projectID: Instance.project.id,
      directory: input.directory,
      workspaceFolders,
      parentID: input.parentID,
      title: input.title ?? createDefaultTitle(!!input.parentID),
      permission: input.permission,
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
      metadata: input.metadata,
    }
    log.info("created", result)
    await Storage.write(["session", Instance.project.id, result.id], result)
    Bus.publish(Event.Created, {
      sessionID: result.id,
      info: result,
    })
    Bus.publish(Event.Updated, {
      sessionID: result.id,
      info: result,
    })
    return result
  }

  export function plan(input: { slug: string; time: { created: number } }) {
    return path.join(Global.Path.data, "plans", [input.time.created, input.slug].join("-") + ".md")
  }

  /**
   * Accepts only canonical session files: readable, valid JSON, and the last key segment equals session.id.
   * Returns undefined when missing; read failures keep their error category so they are never reported as deleted.
   * Tolerant reads for listings and ancestry skip bad records. No full schema validation.
   */
  async function readCanonicalFromKey(key: string[], tolerant = false): Promise<Info | undefined> {
    const filenameId = key.at(-1)
    if (!filenameId) return undefined
    const session = await Storage.read<Info>(key).catch((error: unknown) => {
      if (error instanceof Storage.NotFoundError) return undefined
      const reason = error instanceof SyntaxError ? "invalid_json" : "io"
      log[tolerant ? "warn" : "error"]("session read failed", {
        sessionID: filenameId,
        projectID: key.at(-2),
        reason,
        ...failure(error),
      })
      if (tolerant) return undefined
      throw new ReadError(
        { sessionID: filenameId, reason, message: "Unable to read session data. The session has not been deleted." },
        { cause: error },
      )
    })
    if (session === undefined) return undefined
    if (!session || session.id !== filenameId) {
      if (tolerant) return undefined
      log.error("session read failed", { sessionID: filenameId, projectID: key.at(-2), reason: "invalid_data" })
      throw new ReadError({
        sessionID: filenameId,
        reason: "invalid_data",
        message: "Invalid session data. The session has not been deleted.",
      })
    }
    return migrateRevertToUndoRedo(session) as Info
  }

  async function readCanonicalSession(projectID: string, id: string): Promise<Info | undefined> {
    return readCanonicalFromKey(["session", projectID, id])
  }

  function ghostInfo(id: string, projectID?: string): Info {
    return {
      id,
      slug: "",
      projectID: projectID ?? Instance.project.id,
      directory: Instance.directory,
      title: "",
      version: Installation.VERSION,
      time: {
        created: 0,
        updated: 0,
      },
    }
  }

  function logMissing(id: string, projectID?: string) {
    log.warn("session missing", { sessionID: id, projectID: projectID ?? Instance.project.id })
  }

  function notifyMissing(id: string, projectID?: string) {
    logMissing(id, projectID)
    Bus.publish(Event.Deleted, { sessionID: id, info: ghostInfo(id, projectID) })
  }

  function notFound(id: string) {
    return new Storage.NotFoundError({ message: `Resource not found: session ${id}` })
  }

  export const get = fn(Identifier.schema("session"), async (id) => {
    const session = await readCanonicalSession(Instance.project.id, id)
    if (!session) {
      logMissing(id)
      throw notFound(id)
    }
    return session
  })

  /**
   * Resolves the root session ID by following the parentID chain to the top.
   *
   * Authorization, approvals and scheduled tasks of child sessions (memory extraction, subagents, title generation)
   * are grouped under the root session.
   *
   * Never throws:
   * - if a session in the chain cannot be read, the current one is returned as the root;
   * - a visited set and a depth limit stop safely even if stored data contains a cycle.
   */
  export const rootID = fn(Identifier.schema("session"), async (id) => {
    const MAX_DEPTH = 50
    const visited = new Set<string>()
    let current = id
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (visited.has(current)) break
      visited.add(current)
      const session = await readCanonicalFromKey(["session", Instance.project.id, current], true)
      if (!session?.parentID) return current
      current = session.parentID
    }
    return current
  })

  export const getByProject = fn(
    z.object({ id: Identifier.schema("session"), projectID: z.string() }),
    async (input) => {
      const session = await readCanonicalSession(input.projectID, input.id)
      if (!session) {
        logMissing(input.id, input.projectID)
        throw notFound(input.id)
      }
      return session
    },
  )

  /**
   * Updates a session in a given project, for cases such as cleanup that work outside the current project.
   * Using Instance.project.id there would read the wrong file path.
   */
  export async function updateByProject(
    id: string,
    projectID: string,
    editor: (session: Info) => void,
    options?: { touch?: boolean },
  ) {
    const existing = await readCanonicalSession(projectID, id)
    if (!existing) {
      logMissing(id, projectID)
      throw notFound(id)
    }
    const result = await Storage.update<Info>(["session", projectID, id], (draft) => {
      editor(draft)
      if (options?.touch !== false) {
        draft.time.updated = Date.now()
      }
    })
    Bus.publish(Event.Updated, {
      sessionID: result.id,
      info: result,
    })
    return result
  }

  function migrateRevertToUndoRedo(read: any) {
    // Migrate the legacy revert field to undoRedo
    if (read.revert && !read.undoRedo) {
      read.undoRedo = {
        stack: [
          {
            hiddenMessages: [],
            fileSnapshot: read.revert.snapshot ?? "",
            targetMessageID: read.revert.messageID,
            timestamp: Date.now(),
          },
        ],
      }
    }
    return read
  }

  export async function update(id: string, editor: (session: Info) => void, options?: { touch?: boolean }) {
    const project = Instance.project
    const existing = await readCanonicalSession(project.id, id)
    if (!existing) {
      logMissing(id)
      throw notFound(id)
    }
    const result = await Storage.update<Info>(["session", project.id, id], (draft) => {
      editor(draft)
      if (options?.touch !== false) {
        draft.time.updated = Date.now()
      }
    })
    Bus.publish(Event.Updated, {
      sessionID: result.id,
      info: result,
    })
    return result
  }

  /**
   * Switches the session permission mode (read-only, ask, auto) while it may be running.
   * - Writes the session permissionMode (source of truth); the runner's liveExecution reads it before every tool call,
   *   so it applies immediately, and child sessions follow the root session.
   * - Re-evaluates pending approvals under the new mode and releases those that are now allowed, without waiting for
   *   the next prompt.
   */
  export const setPermissionMode = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      permissionMode: PermissionMode.Schema,
    }),
    async (input) => {
      const started = Date.now()
      const current = await get(input.sessionID).catch(() => undefined)
      const result = await update(
        input.sessionID,
        (draft) => {
          draft.permissionMode = input.permissionMode
        },
        { touch: false },
      ).then(
        (session) => session,
        (error) => {
          log.error("setPermissionMode failed", {
            sessionID: input.sessionID,
            from: current?.permissionMode,
            to: input.permissionMode,
            duration: Date.now() - started,
            ...failure(error),
          })
          throw error
        },
      )
      // Re-evaluate pending approvals (including subagents') under the new mode.
      // Dynamic import breaks the cycle flush -> runner -> session.
      await import("../permission/flush").then((m) => m.PermissionFlush.run())
      log.info("setPermissionMode completed", {
        sessionID: input.sessionID,
        from: current?.permissionMode,
        to: input.permissionMode,
        duration: Date.now() - started,
      })
      return result
    },
  )

  export const diff = fn(Identifier.schema("session"), async (sessionID) => {
    const diffs = await Storage.read<Snapshot.FileDiff[]>(["session_diff", sessionID])
    return diffs ?? []
  })

  export const messages = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      projectID: z.string().optional(),
      limit: z.number().optional(),
    }),
    async (input) => {
      const session =
        input.projectID !== undefined
          ? await getByProject({ id: input.sessionID, projectID: input.projectID })
          : await get(input.sessionID)
      const hiddenSet = new Set<string>()
      for (const entry of session.undoRedo?.stack ?? []) {
        for (const msgID of entry.hiddenMessages) {
          hiddenSet.add(msgID)
        }
      }

      const result = [] as Message.FullMsg[]
      for await (const msg of Message.stream(input.sessionID)) {
        if (input.limit && result.length >= input.limit) break
        if (hiddenSet.has(msg.info.id)) continue
        result.push(msg)
      }
      result.reverse()
      return result
    },
  )

  export async function* list() {
    const project = Instance.project
    let skipped = 0
    for (const item of await Storage.list(["session", project.id])) {
      const session = await readCanonicalFromKey(item, true)
      if (!session) {
        skipped++
        continue
      }
      yield session
    }
    if (skipped > 0) log.warn("session list reconciled", { projectID: project.id, skipped })
  }

  export const children = fn(Identifier.schema("session"), async (parentID) => {
    const project = Instance.project
    const result = [] as Session.Info[]
    for (const item of await Storage.list(["session", project.id])) {
      const session = await readCanonicalFromKey(item, true)
      if (!session) continue
      if (session.parentID !== parentID) continue
      result.push(session)
    }
    return result
  })

  /** All descendant sessions (children, their children, and so on), reading the session list only once */
  export const descendants = fn(Identifier.schema("session"), async (sessionID) => {
    const all: Info[] = []
    for (const item of await Storage.list(["session", Instance.project.id])) {
      const session = await readCanonicalFromKey(item, true)
      if (session?.parentID) all.push(session)
    }
    const result: Info[] = []
    const visit = (parentID: string) =>
      all.filter((item) => item.parentID === parentID).forEach((item) => (result.push(item), visit(item.id)))
    visit(sessionID)
    return result
  })

  async function collectTree(session: Info): Promise<Info[]> {
    const result: Info[] = []
    for (const item of await Storage.list(["session", session.projectID], { strict: true })) {
      const child = await readCanonicalFromKey(item, true)
      if (!child) continue
      if (child.parentID !== session.id) continue
      result.push(...(await collectTree(child)))
    }
    result.push(session)
    return result
  }

  async function clearSession(session: Info) {
    const sessionID = session.id
    await Transcript.drop(sessionID)

    for (const prefix of [
      ["session_notification", sessionID],
      ["workflow", sessionID],
      ["workflow_run", sessionID],
    ]) {
      await Storage.removePrefix(prefix)
    }

    for (const key of [
      ["session_diff", sessionID],
      ["todo", sessionID],
      ["memory_extract", sessionID],
    ]) {
      await Storage.remove(key)
    }

    const backupDir = path.join(Global.Path.data, "storage", "snapshot", sessionID)
    await fs.rm(backupDir, { recursive: true, force: true })
    const { RuleSession } = await import("../rule/session-state")
    RuleSession.invalidate(sessionID)
  }

  export const remove = fn(Identifier.schema("session"), async (sessionID) => {
    const session = await readCanonicalSession(Instance.project.id, sessionID)
    await SessionRunner.cancelTree(sessionID)
    if (!session) {
      await clearSession(ghostInfo(sessionID))
      await Storage.remove(["session", Instance.project.id, sessionID])
      log.info("ghost session removed", { sessionID, projectID: Instance.project.id })
      notifyMissing(sessionID)
      return
    }
    const tree = await collectTree(session)

    // Keep every primary record until the entire tree's related data has been cleared.
    for (const item of tree.toReversed()) {
      await clearSession(item)
    }
    for (const item of tree) {
      await Storage.remove(["session", item.projectID, item.id])
    }
    for (const item of tree) {
      Bus.publish(Event.Deleted, { sessionID: item.id, info: item })
    }
  })

  /**
   * Retention cleanup (off by default, enabled by `storage.retention_days`).
   * Deletes root sessions whose whole tree has been inactive past the cutoff and returns the number of sessions
   * deleted. Activity is the later of the session `time.updated` and the content file mtime, because not every message
   * write updates `time.updated` and relying on it alone would delete sessions in use.
   * Does not depend on the current instance, cancel run loops or publish events: expired sessions are long inactive.
   */
  export async function expire(cutoff: number) {
    let count = 0
    for (const key of await Storage.list(["session"])) {
      const session = await readCanonicalFromKey(key, true)
      if (!session || session.parentID) continue
      const tree = await collectTree(session)
      const latest = Math.max(...(await Promise.all(tree.map(activity))))
      if (latest >= cutoff) continue
      for (const item of tree.toReversed()) await clearSession(item)
      for (const item of tree) await Storage.remove(["session", item.projectID, item.id])
      count += tree.length
    }
    return count
  }

  async function activity(session: Info) {
    const modified = await fs.stat(Transcript.file(session.id)).then(
      (stat) => stat.mtimeMs,
      () => 0,
    )
    return Math.max(session.time.updated, modified)
  }

  export const updateInfo = fn(Message.Info, async (info) => {
    // Merges like `Object.assign(draft, info)`: fields not provided keep their stored values.
    const next = await Transcript.update(info.sessionID, info.id, (prev) =>
      prev ? ({ ...prev, ...info } as Message.Info) : { ...info },
    )
    Bus.publish(Message.Event.Updated, {
      sessionID: next.sessionID,
      info: next,
    })
    return next
  })

  export const removeMessage = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      // A remove record without partID deletes the message and all its parts (opencode 1.16.2
      // `session.deleteMessage` semantics)
      await Transcript.remove(input.sessionID, input.messageID)
      Bus.publish(Message.Event.Removed, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    },
  )

  export const removePart = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
      partID: Identifier.schema("part"),
    }),
    async (input) => {
      await Transcript.remove(input.sessionID, input.messageID, input.partID)
      Bus.publish(Message.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    },
  )

  const UpdatePartInput = z.union([
    Message.Part,
    z.object({
      part: Message.TextPart,
      delta: z.string(),
    }),
    z.object({
      part: Message.ReasoningPart,
      delta: z.string(),
    }),
  ])

  export const updatePart = fn(UpdatePartInput, async (input) => {
    // Either a bare Part or a streaming delta wrapper {part, delta}
    const wrapped = "part" in input ? input : undefined
    const part = wrapped ? wrapped.part : (input as Message.Part)
    const delta = wrapped?.delta
    // A failed part write must not end the turn. The in-memory part is still published on the Bus for the UI; at worst
    // that part is not persisted. See Transcript.part for how streaming chunks and tool input streaming are persisted.
    const accepted = await Transcript.part(part, delta).catch((err) => {
      log.error("updatePart persist failed (isolated)", {
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        type: part.type,
        ...failure(err),
      })
      return true
    })
    if (!accepted) return part
    Bus.publish(Message.Event.PartUpdated, {
      part,
      delta,
    })
    return part
  })

  export const getUsage = fn(
    z.object({
      model: z.custom<Provider.Model>(),
      usage: z.custom<LanguageModelUsage>(),
      metadata: z.custom<ProviderMetadata>().optional(),
    }),
    (input) => {
      const safe = (value: number | undefined) => (Number.isFinite(value) ? value! : 0)
      // The AI SDK normalizes usage per provider: inputTokens includes cache reads and writes, broken down in
      // inputTokenDetails
      const cacheRead = safe(input.usage.inputTokenDetails?.cacheReadTokens)
      const cacheWrite = safe(input.usage.inputTokenDetails?.cacheWriteTokens)
      const inputTotal = safe(input.usage.inputTokens)
      const outputTokens = safe(input.usage.outputTokens)
      const tokens = {
        total: safe(input.usage.totalTokens) || inputTotal + outputTokens,
        input: safe(input.usage.inputTokenDetails?.noCacheTokens ?? inputTotal - cacheRead - cacheWrite),
        output: outputTokens,
        reasoning: safe(input.usage.outputTokenDetails?.reasoningTokens),
        cache: { write: cacheWrite, read: cacheRead },
      }

      const costInfo =
        input.model.cost?.experimentalOver200K && tokens.input + tokens.cache.read > 200_000
          ? input.model.cost.experimentalOver200K
          : input.model.cost
      return {
        cost: safe(
          new Decimal(0)
            .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
            .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
            // Reasoning tokens are already included in output tokens and billed at the output price
            .toNumber(),
        ),
        tokens,
      }
    },
  )

  export class BusyError extends Error {
    constructor(public readonly sessionID: string) {
      super(`Session ${sessionID} is busy`)
    }
  }

  export const initialize = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      modelID: z.string(),
      providerID: z.string(),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      await SessionDispatch.command({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.providerID + "/" + input.modelID,
        command: Command.Default.INIT,
        arguments: "",
      })
    },
  )
}
