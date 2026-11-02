import z from "zod"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { NamedError } from "@merakcode/util/error"
import { Filesystem } from "@merakcode/util/filesystem"
import { Lock } from "../../infra/concurrency/lock"
import { Atomic } from "../../infra/file/atomic"
import { Storage } from "../../infra/storage/storage"
import { Session } from "./index"
import { SessionStore } from "./store"
import { Bus } from "../../infra/bus"
import { BusEvent } from "../../infra/bus/bus-event"
import { Message } from "./message"
import { Text } from "../prompt/text"
import { Global } from "../../infra/global"
import { Log } from "@merakcode/log/logger"

/** One editable plan per root session. Revisions coordinate writers; they are not plan history. */
export namespace SessionPlan {
  const log = Log.create({ service: "session.plan" })
  export const ConflictError = NamedError.create("PlanConflictError", z.object({ message: z.string() }))
  export const Info = z
    .object({
      sessionID: z.string(),
      path: z.string(),
      content: z.string(),
      revision: z.number().int().nonnegative(),
      humanRevision: z.number().int().nonnegative(),
      source: z.enum(["human", "agent"]),
      status: z.enum(["draft", "review", "executing", "completed"]),
      execution: z.object({ id: z.string(), content: z.string(), startedAt: z.number() }).optional(),
      blockedUserID: z.string().optional(),
      activeUserID: z.string().optional(),
    })
    .meta({ ref: "SessionPlan" })
  export type Info = z.infer<typeof Info>
  export const Save = z.object({ content: z.string(), expectedRevision: z.number().int().nonnegative() })
  export const Updated = BusEvent.define("session.plan.updated", Info)

  function notify(info: Info) {
    void Bus.publish(Updated, info).catch((error) =>
      log.warn("plan update notification failed", { sessionID: info.sessionID, error }),
    )
  }

  async function validatePath(file: string) {
    const expectedDirectory = path.join(Global.Path.data, "plans")
    if (path.resolve(path.dirname(file)) !== path.resolve(expectedDirectory))
      throw new ConflictError({
        message: await Text.pick({
          zh: "计划路径超出允许的目录。",
          en: "The plan path is outside the managed directory.",
        }),
      })
    const actualParent = await fs.realpath(path.dirname(file)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    const expectedParent = path.join(await fs.realpath(Global.Path.data), "plans")
    const canonical = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if ((actualParent && canonical(actualParent) !== canonical(expectedParent)) || stat?.isSymbolicLink())
      throw new ConflictError({
        message: await Text.pick({
          zh: "计划路径已被链接重定向，请恢复正常路径。",
          en: "The plan path is redirected by a link. Restore the normal path before continuing.",
        }),
      })
  }

  async function current(sessionID: string): Promise<Info> {
    const session = await Session.get(sessionID)
    const file = Session.plan(session)
    await validatePath(file)
    const legacy = legacyPath(session)
    if (legacy && !(await Filesystem.isFile(file))) {
      await validatePath(legacy)
      await fs.copyFile(legacy, file, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error
      })
    }
    const content = await Filesystem.readText(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    const saved = await Storage.read<Info>(["session_plan", sessionID]).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (saved?.content === content) return { ...saved, path: file }
    const revision = (saved?.revision ?? 0) + (content || saved ? 1 : 0)
    const result: Info = {
      ...saved,
      blockedUserID: saved?.activeUserID ?? saved?.blockedUserID,
      sessionID,
      path: file,
      content,
      revision,
      humanRevision: revision,
      source: "human",
      status: saved?.status ?? "draft",
      execution: saved?.execution,
    }
    if (content || saved) {
      await Storage.write(["session_plan", sessionID], result)
      notify(result)
    }
    return result
  }

  export async function get(sessionID: string) {
    sessionID = await Session.rootID(sessionID)
    using _ = await Lock.write(`plan:${sessionID}`)
    return await current(sessionID)
  }

  export async function save(
    input: z.infer<typeof Save> & {
      sessionID: string
      source: "human" | "agent"
      userMessageID?: string
      abort?: AbortSignal
    },
  ) {
    input = { ...input, sessionID: await Session.rootID(input.sessionID) }
    using _ = await Lock.write(`plan:${input.sessionID}`)
    const previous = await current(input.sessionID)
    const userMessageID = previous.activeUserID ?? input.userMessageID
    if (input.source === "agent" && userMessageID && previous.blockedUserID === userMessageID)
      throw new ConflictError({
        message: await Text.pick({
          zh: "已保留人工修改，请等待新的修改要求后再编辑计划。",
          en: "Human edits take priority. Wait for new user instructions before editing the plan again.",
        }),
      })
    if (
      input.expectedRevision !== previous.revision &&
      (input.source === "agent" || previous.humanRevision > input.expectedRevision)
    )
      throw new ConflictError({
        message: await Text.pick({
          zh: "计划存在编辑冲突。已保留人工修改，请重新读取计划。",
          en: "Plan conflict: keep human edits and reread the current plan.",
        }),
      })
    await fs.mkdir(path.dirname(previous.path), { recursive: true })
    await validatePath(previous.path)
    input.abort?.throwIfAborted()
    await Atomic.write(previous.path, input.content)
    const revision = previous.revision + 1
    let blockedUserID = previous.blockedUserID
    if (input.source === "human") {
      blockedUserID = previous.activeUserID
      if (!blockedUserID)
        for await (const message of Message.stream(input.sessionID)) {
          if (message.info.role === "user" && Message.userSourceTexts(message).some((text) => text.trim())) {
            blockedUserID = message.info.id
            break
          }
        }
    }
    const result: Info = {
      ...previous,
      content: input.content,
      revision,
      source: input.source,
      blockedUserID,
      humanRevision: input.source === "human" ? revision : previous.humanRevision,
      status:
        previous.status === "executing" || (input.source === "human" && previous.status === "review")
          ? previous.status
          : "draft",
    }
    await Storage.write(["session_plan", input.sessionID], result)
    notify(result)
    return result
  }

  export async function beginTurn(sessionID: string, userMessageID: string) {
    sessionID = await Session.rootID(sessionID)
    using _ = await Lock.write(`plan:${sessionID}`)
    const result = await current(sessionID)
    result.activeUserID = userMessageID
    await Storage.write(["session_plan", sessionID], result)
  }

  function legacyPath(session: Session.Info) {
    if (!session.slug) return undefined
    const name = `${session.time.created}-${session.slug}.md`
    if (path.basename(name) !== name || /[\\/:*?"<>|\x00-\x1f]/.test(name)) return undefined
    return path.join(Global.Path.data, "plans", name)
  }

  /** Validate the entire deletion set before touching files or session records. */
  export async function removeFiles(sessions: Session.Info[]) {
    const removing = new Set(sessions.map((session) => session.id))
    const remainingLegacy = SessionStore.all()
      .filter((session) => !removing.has(session.id))
      .flatMap((session) => {
        const legacy = legacyPath(session)
        return legacy ? [legacy] : []
      })
    const files = new Set<string>()
    for (const session of sessions) {
      files.add(Session.plan(session))
      const legacy = legacyPath(session)
      if (!legacy) continue
      const shared = await Promise.all(remainingLegacy.map((other) => sameFile(legacy, other)))
      if (!shared.some(Boolean)) files.add(legacy)
    }
    for (const file of files) await validatePath(file)
    for (const file of files) await fs.rm(file, { force: true })
  }

  export async function isFile(sessionID: string, filePath: string) {
    if (!SessionStore.find(sessionID)) return false
    const session = await Session.get(await Session.rootID(sessionID)).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (!session) return false
    const official = Session.plan(session)
    if (await sameFile(filePath, official)) return true
    const legacy = legacyPath(session)
    if (!legacy || !(await sameFile(filePath, legacy))) return false
    await validatePath(legacy)
    return true
  }

  async function sameFile(filePath: string, official: string) {
    const samePath =
      process.platform === "win32"
        ? path.resolve(filePath).toLowerCase() === path.resolve(official).toLowerCase()
        : path.resolve(filePath) === path.resolve(official)
    // File identity also covers case aliases on case-insensitive macOS volumes without assuming every volume is so.
    return (
      samePath ||
      (await Promise.all([fs.stat(filePath), fs.stat(official)])
        .then(([target, official]) => target.dev === official.dev && target.ino === official.ino)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false
          throw error
        }))
    )
  }

  export async function writeFromAgent(input: {
    sessionID: string
    path: string
    content: string
    expectedRevision?: number
    abort?: AbortSignal
  }) {
    if (!(await isFile(input.sessionID, input.path))) return false
    const root = await Session.rootID(input.sessionID)
    const currentPlan = await get(root)
    await save({
      sessionID: root,
      content: input.content,
      source: "agent",
      abort: input.abort,
      expectedRevision: input.expectedRevision ?? currentPlan.revision,
    })
    return true
  }

  /** Tool reads use the fixed execution view; the plan API exposes the editable human document. */
  export async function contentForTool(sessionID: string, filePath: string) {
    if (!(await isFile(sessionID, filePath))) return undefined
    const plan = await get(await Session.rootID(sessionID))
    return plan.status === "executing" ? plan.execution?.content : plan.content
  }

  export async function start(sessionID: string) {
    sessionID = await Session.rootID(sessionID)
    using _ = await Lock.write(`plan:${sessionID}`)
    const result = await current(sessionID)
    if (result.status === "executing") return result
    if (!result.content.trim())
      throw new ConflictError({
        message: await Text.pick({ zh: "请先保存计划再开始执行。", en: "Save a plan before starting execution." }),
      })
    result.status = "executing"
    result.execution = { id: randomUUID(), content: result.content, startedAt: Date.now() }
    await Storage.write(["session_plan", sessionID], result)
    notify(result)
    return result
  }

  export async function setStatus(sessionID: string, status: "draft" | "review" | "completed", abort?: AbortSignal) {
    sessionID = await Session.rootID(sessionID)
    using _ = await Lock.write(`plan:${sessionID}`)
    const result = await current(sessionID)
    abort?.throwIfAborted()
    if (result.status === "executing" && status !== "completed") return result
    result.status = status
    await Storage.write(["session_plan", sessionID], result)
    notify(result)
    return result
  }
}
