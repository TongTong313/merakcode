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
import { SessionStore } from "./store"
import { Transcript } from "./transcript"
import { ReviewBaseline } from "../review/baseline"
import { SessionMemoryPath } from "../session-memory/path"
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
import { Filesystem } from "@merakcode/util/filesystem"

export namespace Session {
  const log = Log.create({ service: "session" })

  export const ReadError = NamedError.create(
    "SessionReadError",
    z.object({
      sessionID: z.string(),
      reason: z.literal("invalid_data"),
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
    metadata?: Info["metadata"]
    filterCompacted?: boolean
  }): Promise<Info> {
    const original = await get(input.sessionID)
    if (!original) throw new Error("session not found")
    let session = await createNext({
      directory: Instance.directory,
      title: input.title,
      parentID: input.parentID,
      permission: input.permission,
      metadata: input.metadata,
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
      metadata: Info.shape.metadata,
    }),
    async (input) =>
      forkInto({
        sessionID: input.sessionID,
        messageID: input.messageID,
        parentID: input.parentID,
        title: input.title,
        permission: input.permission,
        metadata: input.metadata,
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
    SessionStore.put(result)
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
   * Returns undefined when the session does not exist. Damaged stored data is a read failure, never reported as
   * deleted; tolerant reads (ancestry) skip it instead. No full schema validation.
   */
  function readCanonicalSession(projectID: string, id: string, tolerant = false): Info | undefined {
    try {
      const session = SessionStore.get(projectID, id)
      return session && (migrateRevertToUndoRedo(session) as Info)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      log[tolerant ? "warn" : "error"]("session read failed", {
        sessionID: id,
        projectID,
        reason: "invalid_data",
        ...failure(error),
      })
      if (tolerant) return undefined
      throw new ReadError(
        { sessionID: id, reason: "invalid_data", message: "Invalid session data. The session has not been deleted." },
        { cause: error },
      )
    }
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
    const session = readCanonicalSession(Instance.project.id, id)
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
      const session = readCanonicalSession(Instance.project.id, current, true)
      if (!session?.parentID) return current
      current = session.parentID
    }
    return current
  })

  export const getByProject = fn(
    z.object({ id: Identifier.schema("session"), projectID: z.string() }),
    async (input) => {
      const session = readCanonicalSession(input.projectID, input.id)
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
    const result = edit(projectID, id, editor, options)
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

  /** Reads, edits and writes the session in one transaction */
  function edit(projectID: string, id: string, editor: (session: Info) => void, options?: { touch?: boolean }) {
    if (!readCanonicalSession(projectID, id)) {
      logMissing(id, projectID)
      throw notFound(id)
    }
    const result = SessionStore.update(projectID, id, (draft) => {
      editor(draft)
      if (options?.touch !== false) {
        draft.time.updated = Date.now()
      }
    })
    if (!result) {
      logMissing(id, projectID)
      throw notFound(id)
    }
    return result
  }

  export async function update(id: string, editor: (session: Info) => void, options?: { touch?: boolean }) {
    const result = edit(Instance.project.id, id, editor, options)
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
    for (const session of SessionStore.list(Instance.project.id)) yield migrateRevertToUndoRedo(session) as Info
  }

  export const SearchResult = z
    .object({
      session: Info,
      match: z
        .object({ messageID: z.string(), text: z.string() })
        .optional()
        .meta({ description: "The latest conversation text containing the search, shortened around it" }),
    })
    .meta({ ref: "SessionSearchResult" })
  export type SearchResult = z.infer<typeof SearchResult>

  /** One line around the first occurrence of term: a little before it and more after */
  function snippet(text: string, term: string) {
    const flat = text.replace(/\s+/g, " ").trim()
    const at = Math.max(0, flat.toLowerCase().indexOf(term.toLowerCase()))
    const start = Math.max(0, at - 20)
    const end = Math.min(flat.length, at + term.length + 60)
    return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "")
  }

  /** Sessions of this project whose title or conversation text contains the search, most recently updated first */
  export function search(input: { search: string; directory?: string; roots?: boolean; limit?: number }) {
    return SessionStore.search({ term: input.search, projectID: Instance.project.id, roots: input.roots })
      .filter(
        (item) => input.directory === undefined || Filesystem.sameDirectory(item.session.directory, input.directory),
      )
      .slice(0, input.limit)
      .map((item): SearchResult => ({
        session: migrateRevertToUndoRedo(item.session) as Info,
        ...(item.match && { match: { messageID: item.match.messageID, text: snippet(item.match.text, input.search) } }),
      }))
  }

  export const children = fn(Identifier.schema("session"), async (parentID) => {
    const projectID = Instance.project.id
    return SessionStore.children(parentID).filter((session) => session.projectID === projectID)
  })

  /** All descendant sessions (children, their children, and so on) */
  export const descendants = fn(Identifier.schema("session"), async (sessionID) =>
    collectTree(sessionID).filter((session) => session.projectID === Instance.project.id),
  )

  /** Every session below the given one, each parent before its children */
  function collectTree(sessionID: string): Info[] {
    return SessionStore.children(sessionID).flatMap((child) => [child, ...collectTree(child.id)])
  }

  async function clearSession(session: Info) {
    const sessionID = session.id
    await Transcript.drop(sessionID)

    for (const prefix of [
      ["session_notification", sessionID],
      ["workflow", sessionID],
      ["workflow_run", sessionID],
      ["cron", sessionID],
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

    ReviewBaseline.drop(sessionID)
    await Snapshot.drop(sessionID)
    await fs.rm(plan(session), { force: true })
    const { RuleSession } = await import("../rule/session-state")
    RuleSession.invalidate(sessionID)
  }

  export const remove = fn(Identifier.schema("session"), async (sessionID) => {
    const session = readCanonicalSession(Instance.project.id, sessionID)
    await SessionRunner.cancelTree(sessionID)
    const { LoopScheduler } = await import("../scheduler/loop")
    await LoopScheduler.removeBySession(sessionID)
    if (!session) {
      await clearSession(ghostInfo(sessionID))
      await fs.rm(SessionMemoryPath.directory(sessionID), { recursive: true, force: true })
      SessionStore.remove(sessionID)
      log.info("ghost session removed", { sessionID, projectID: Instance.project.id })
      notifyMissing(sessionID)
      return
    }
    const tree = [...collectTree(session.id), session]

    // Keep every primary record until the entire tree's related data has been cleared.
    for (const item of tree) {
      await clearSession(item)
      await fs.rm(SessionMemoryPath.directory(item.id), { recursive: true, force: true })
    }
    for (const item of tree) SessionStore.remove(item.id)
    for (const item of tree) {
      Bus.publish(Event.Deleted, { sessionID: item.id, info: item })
    }
  })

  /**
   * Retention cleanup (off by default, enabled by `storage.retention_days`).
   * Deletes root sessions whose whole tree has been inactive past the cutoff and returns the number of sessions
   * deleted. Activity is the later of the session `time.updated` and the last content write, because not every
   * message write updates `time.updated` and relying on it alone would delete sessions in use.
   * Does not depend on the current instance, cancel run loops or publish events: expired sessions are long inactive.
   */
  export async function expire(cutoff: number) {
    let count = 0
    for (const session of SessionStore.all().filter((item) => !item.parentID)) {
      const tree = [...collectTree(session.id), session]
      const latest = Math.max(...tree.map((item) => Math.max(item.time.updated, Transcript.written(item.id))))
      if (latest >= cutoff) continue
      for (const item of tree) await clearSession(item)
      for (const item of tree) SessionStore.remove(item.id)
      count += tree.length
    }
    return count
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
