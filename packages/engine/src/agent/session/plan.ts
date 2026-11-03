import z from "zod"
import { randomUUID, createHash } from "node:crypto"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
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
import { diffLines } from "diff"
import { Token } from "../context/token"
import { PlanConflictError, PlanReadRangeError, PlanExecutionPausedError } from "./plan-error"
import { Instance } from "../../infra/project/instance"

/** One editable plan per root session. Revisions coordinate writers; they are not plan history. */
export namespace SessionPlan {
  const log = Log.create({ service: "session.plan" })
  export const ConflictError = PlanConflictError
  export const RangeError = PlanReadRangeError
  export const PausedError = PlanExecutionPausedError
  export const Candidate = z
    .object({
      id: z.string(),
      content: z.string(),
      expectedRevision: z.number(),
      originalTokens: z.number(),
      candidateTokens: z.number(),
      changes: z.array(z.object({ type: z.enum(["same", "delete", "insert"]), text: z.string() })),
    })
    .meta({ ref: "PlanCandidate" })
  export const ChunkInput = z.object({
    offset: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(16000).default(8000),
    executionID: z.string().uuid().optional(),
  })
  export const Chunk = z
    .object({
      content: z.string(),
      offset: z.number(),
      nextOffset: z.number().optional(),
      totalCharacters: z.number(),
      revision: z.number(),
      executionID: z.string().optional(),
    })
    .meta({ ref: "PlanChunk" })
  export const Info = z
    .object({
      sessionID: z.string(),
      path: z.string(),
      content: z.string(),
      revision: z.number().int().nonnegative(),
      humanRevision: z.number().int().nonnegative(),
      source: z.enum(["human", "agent"]),
      status: z.enum(["draft", "review", "executing", "completed", "failed", "stopped", "paused"]),
      execution: z
        .object({
          id: z.string(),
          content: z.string(),
          startedAt: z.number(),
          revision: z.number().optional(),
          source: z.enum(["button", "chat"]).optional(),
        })
        .optional(),
      buttonLocked: z.boolean().optional(),
      queued: z.boolean().optional(),
      candidate: Candidate.optional(),
      blockedUserID: z.string().optional(),
      activeUserID: z.string().optional(),
      anchorMessageID: z.string().optional(),
    })
    .meta({ ref: "SessionPlan" })
  export type Info = z.infer<typeof Info>
  type Submission = { messageID: string; callID: string; signature: string }
  type Record = Info & {
    submissions?: { [key: string]: { signature: string; revision: number } }
    successfulButton?: { hash: string; executionID: string }
    idleTurns?: number
    lastCountedUserID?: string
  }
  export const Save = z.object({ content: z.string(), expectedRevision: z.number().int().nonnegative() })
  export const Updated = BusEvent.define("session.plan.updated", Info)
  const queued = Instance.state(() => new Map<string, string>())

  function publicInfo(record: Record): Info {
    return Info.parse({
      ...record,
      queued: queued().has(record.sessionID),
      buttonLocked: record.successfulButton?.hash === contentHash(record.content),
    })
  }

  export async function queue(sessionID: string, requestID: string) {
    using _ = await Lock.write(`plan:${sessionID}`)
    queued().set(sessionID, requestID)
    notify(await current(sessionID))
  }

  export async function dequeue(sessionID: string, requestID: string) {
    using _ = await Lock.write(`plan:${sessionID}`)
    if (queued().get(sessionID) !== requestID) return
    queued().delete(sessionID)
    notify(await current(sessionID))
  }

  function notify(info: Record) {
    void Bus.publish(Updated, publicInfo(info)).catch((error) =>
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

  async function current(sessionID: string): Promise<Record> {
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
    const saved = await Storage.read<Record>(["session_plan", sessionID]).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (saved?.content === content) return { ...saved, path: file }
    const revision = (saved?.revision ?? 0) + (content || saved ? 1 : 0)
    const result: Record = {
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
    const result = await current(sessionID)
    return publicInfo(result)
  }

  function contentHash(content: string) {
    return createHash("sha256").update(content.replace(/\r\n?/g, "\n")).digest("hex")
  }

  async function receipt(previous: Record, submission: Submission) {
    const key = `${submission.messageID}:${submission.callID}`
    const signature = createHash("sha256").update(submission.signature).digest("hex")
    const known = previous.submissions?.[key]
    if (!known) return { key, signature }
    if (known.signature !== signature)
      throw new ConflictError({
        message: await Text.pick({
          zh: "同一计划调用不能使用不同参数重投。",
          en: "A plan call cannot be reused with different arguments.",
        }),
      })
    return { key, signature, revision: known.revision, path: previous.path }
  }

  export async function submission(sessionID: string, input: Submission) {
    sessionID = await Session.rootID(sessionID)
    using _ = await Lock.write(`plan:${sessionID}`)
    const result = await receipt(await current(sessionID), input)
    return result.revision === undefined ? undefined : { path: result.path!, revision: result.revision }
  }

  export async function save(
    input: z.infer<typeof Save> & {
      sessionID: string
      source: "human" | "agent"
      userMessageID?: string
      abort?: AbortSignal
      submission?: Submission
      strict?: boolean
    },
  ) {
    input = { ...input, sessionID: await Session.rootID(input.sessionID) }
    using _ = await Lock.write(`plan:${input.sessionID}`)
    const previous = await current(input.sessionID)
    const submitted =
      input.source === "agent" && input.submission ? await receipt(previous, input.submission) : undefined
    if (submitted?.revision !== undefined) return Info.parse({ ...previous, revision: submitted.revision })
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
      (input.strict || input.source === "agent" || previous.humanRevision > input.expectedRevision)
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
    const result: Record = {
      ...previous,
      content: input.content,
      revision,
      source: input.source,
      candidate: undefined,
      idleTurns: 0,
      blockedUserID,
      humanRevision: input.source === "human" ? revision : previous.humanRevision,
      anchorMessageID: previous.anchorMessageID ?? (input.source === "agent" ? input.submission?.messageID : undefined),
      submissions: submitted
        ? { ...previous.submissions, [submitted.key]: { signature: submitted.signature, revision } }
        : previous.submissions,
      status:
        ["executing", "paused"].includes(previous.status) || (input.source === "human" && previous.status === "review")
          ? previous.status
          : input.source === "agent" && input.submission
            ? "review"
            : "draft",
    }
    await Storage.write(["session_plan", input.sessionID], result)
    notify(result)
    return Info.parse(result)
  }

  export async function beginTurn(sessionID: string, userMessageID: string) {
    sessionID = await Session.rootID(sessionID)
    using _ = await Lock.write(`plan:${sessionID}`)
    const result = await current(sessionID)
    result.activeUserID = userMessageID
    const message = await Message.get({ sessionID, messageID: userMessageID }).catch(() => undefined)
    if (message && related(Message.userSourceTexts(message).join("\n"))) result.idleTurns = 0
    await Storage.write(["session_plan", sessionID], result)
  }

  function related(text: string) {
    return /计划|方案|第[一二三四五六七八九十\d]+步|精简|\bplan\b|\bstep\s+\d+\b/i.test(text)
  }

  export async function completeTurn(sessionID: string, userMessageID: string) {
    using _ = await Lock.write(`plan:${sessionID}`)
    const plan = await current(sessionID)
    if (!plan.content || plan.status === "executing" || plan.lastCountedUserID === userMessageID) return
    const message = await Message.get({ sessionID, messageID: userMessageID }).catch(() => undefined)
    if (!message || message.info.role !== "user") return
    const text = Message.userSourceTexts(message).join("\n").trim()
    if (!text) return
    plan.lastCountedUserID = userMessageID
    plan.idleTurns = related(text) ? 0 : (plan.idleTurns ?? 0) + 1
    await Storage.write(["session_plan", sessionID], plan)
  }

  export async function view(sessionID: string) {
    sessionID = await Session.rootID(sessionID)
    using _ = await Lock.write(`plan:${sessionID}`)
    const plan = await current(sessionID)
    plan.idleTurns = 0
    await Storage.write(["session_plan", sessionID], plan)
    return Info.parse(plan)
  }

  export async function context(sessionID: string, text: string, full = false) {
    sessionID = await Session.rootID(sessionID)
    using _ = await Lock.write(`plan:${sessionID}`)
    const plan = await current(sessionID)
    if (plan.execution && ["executing", "paused"].includes(plan.status))
      return `Execution plan ${plan.execution.id} (immutable snapshot):\n${plan.execution.content}`
    if (!plan.content) return ""
    const reference = `Official plan at ${plan.path}, revision ${plan.revision}. Use plan_read_chunk to read all ranges when needed.`
    if (full || related(text) || (Token.estimate(plan.content) >= 2048 && (plan.idleTurns ?? 0) < 3))
      return `${reference}\n${plan.content}`
    return reference
  }

  export async function chunk(sessionID: string, input: z.infer<typeof ChunkInput>) {
    const plan = await get(sessionID)
    const execution = input.executionID
      ? await Storage.read<NonNullable<Info["execution"]>>([
          "session_plan_execution",
          plan.sessionID,
          input.executionID,
        ])
      : undefined
    const content = execution?.content ?? plan.content
    if (input.offset > content.length)
      throw new RangeError({
        message: await Text.pick({
          zh: "计划读取位置超出正文范围。",
          en: "The plan read offset is outside the document.",
        }),
      })
    const end = Math.min(content.length, input.offset + input.limit)
    return {
      content: content.slice(input.offset, end),
      offset: input.offset,
      nextOffset: end < content.length ? end : undefined,
      totalCharacters: content.length,
      revision: execution?.revision ?? plan.revision,
      executionID: execution?.id,
    }
  }

  export function inputForTask(plan: Info, text = "", required = false) {
    if (plan.execution && ["executing", "paused"].includes(plan.status))
      return {
        content: plan.execution.content,
        revision: plan.execution.revision ?? plan.revision,
        executionID: plan.execution.id,
      }
    if (required || (plan.content.trim() && related(text)))
      return { content: plan.content, revision: plan.revision, executionID: undefined }
  }

  export async function assertInputCurrent(sessionID: string, input: { revision: number; executionID?: string }) {
    const plan = await get(sessionID)
    const matches = input.executionID
      ? plan.status === "executing" && plan.execution?.id === input.executionID
      : plan.revision === input.revision && !["executing", "paused"].includes(plan.status)
    if (matches) return
    throw new ConflictError({
      message: await Text.pick({
        zh: "计划已变化，请重新读取后发送任务。",
        en: "The plan changed. Reread it before sending the task.",
      }),
    })
  }

  export async function propose(sessionID: string, input: z.infer<typeof Save>) {
    sessionID = await Session.rootID(sessionID)
    using _ = await Lock.write(`plan:${sessionID}`)
    const plan = await current(sessionID)
    if (plan.revision !== input.expectedRevision)
      throw new ConflictError({
        message: await Text.pick({
          zh: "计划已变化，请重新读取后生成精简稿。",
          en: "The plan changed. Reread it before proposing a simplification.",
        }),
      })
    const candidate = Candidate.parse({
      id: randomUUID(),
      content: input.content,
      expectedRevision: plan.revision,
      originalTokens: Token.estimate(plan.content),
      candidateTokens: Token.estimate(input.content),
      changes: diffLines(plan.content, input.content).map((change) => ({
        type: change.added ? "insert" : change.removed ? "delete" : "same",
        text: change.value,
      })),
    })
    plan.candidate = candidate
    await Storage.write(["session_plan", sessionID], plan)
    notify(plan)
    return candidate
  }

  export async function adopt(sessionID: string, candidateID: string) {
    const plan = await get(sessionID)
    if (!plan.candidate || plan.candidate.id !== candidateID || plan.candidate.expectedRevision !== plan.revision)
      throw new ConflictError({
        message: await Text.pick({
          zh: "精简稿已过期，请重新核对计划。",
          en: "The candidate is stale. Review the current plan again.",
        }),
      })
    return save({
      sessionID,
      source: "human",
      content: plan.candidate.content,
      expectedRevision: plan.revision,
      strict: true,
    })
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

  /** Tool reads use the fixed execution view; the plan API exposes the editable human document. */
  export async function contentForTool(sessionID: string, filePath: string) {
    if (!(await isFile(sessionID, filePath))) return undefined
    const plan = await get(await Session.rootID(sessionID))
    return ["executing", "paused"].includes(plan.status) ? plan.execution?.content : plan.content
  }

  export async function start(sessionID: string, source: "button" | "chat" = "chat", expectedRevision?: number) {
    sessionID = await Session.rootID(sessionID)
    using _ = await Lock.write(`plan:${sessionID}`)
    const result = await current(sessionID)
    queued().delete(sessionID)
    if (result.status === "executing") return result
    if (result.status === "paused" && result.execution) {
      result.status = "executing"
      await Storage.write(["session_plan", sessionID], result)
      notify(result)
      return result
    }
    if (expectedRevision !== undefined && expectedRevision !== result.revision)
      throw new ConflictError({
        message: await Text.pick({
          zh: "计划已变化，请重新读取后启动。",
          en: "The plan changed. Reread it before starting.",
        }),
      })
    if (!result.content.trim())
      throw new ConflictError({
        message: await Text.pick({ zh: "请先保存计划再开始执行。", en: "Save a plan before starting execution." }),
      })
    result.status = "executing"
    result.execution = {
      id: randomUUID(),
      content: result.content,
      startedAt: Date.now(),
      revision: result.revision,
      source,
    }
    await Storage.write(["session_plan", sessionID], result)
    await Storage.write(["session_plan_execution", sessionID, result.execution.id], result.execution)
    notify(result)
    return result
  }

  export async function setStatus(
    sessionID: string,
    status: Info["status"],
    abort?: AbortSignal,
    executionID?: string,
  ) {
    sessionID = await Session.rootID(sessionID)
    using _ = await Lock.write(`plan:${sessionID}`)
    const result = await current(sessionID)
    abort?.throwIfAborted()
    if (executionID !== undefined && executionID !== result.execution?.id) return result
    if (result.status === "executing" && (status === "draft" || status === "review")) return result
    result.status = status
    if (status === "completed" && result.execution?.source === "button")
      result.successfulButton = { hash: contentHash(result.execution.content), executionID: result.execution.id }
    await Storage.write(["session_plan", sessionID], result)
    notify(result)
    return result
  }
}
