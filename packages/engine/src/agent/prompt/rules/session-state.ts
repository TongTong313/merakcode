import path from "path"
import { Instance } from "../../../infra/project/instance"
import { Flag } from "../../../infra/flag/flag"
import type { Message } from "../../session/message"
import { Filesystem } from "@merakcode/util/filesystem"
import { Rule } from "./rule"
import { RuleMatch } from "./match"

/**
 * Per-session rule state: the pin list plus the recent files and user turns used by the glob working set.
 * Session.Info.rules is the persisted source of truth and Instance.state a hot cache. Without a stored session
 * (fake ids in unit tests) only the cache is kept.
 */
export namespace RuleSession {
  export type PinSource = "mention" | "fetch"
  export type MentionAction = "pin" | "skip" | "file"

  export type Pin = {
    filepath: string
    source: PinSource
  }

  export type RecentFile = {
    path: string
    userMessageID: string
  }

  export type Data = {
    pinned: Pin[]
    recentFiles: RecentFile[]
    userTurns: string[]
  }

  const USER_TURN_CAP = 16
  const RECENT_FILE_CAP = 100

  const cache = Instance.state(() => ({
    bySession: new Map<string, Data>(),
  }))

  function empty(): Data {
    return { pinned: [], recentFiles: [], userTurns: [] }
  }

  async function sessionApi() {
    const { Session } = await import("../../session")
    return Session
  }

  function fromSession(rules: { pinned?: Pin[]; recentFiles?: RecentFile[]; userTurns?: string[] } | undefined): Data {
    return {
      pinned: (rules?.pinned ?? []).map((item) => ({ ...item })),
      recentFiles: (rules?.recentFiles ?? []).map((item) => ({ ...item })),
      userTurns: [...(rules?.userTurns ?? [])],
    }
  }

  async function load(sessionID: string): Promise<Data> {
    const map = cache().bySession
    const hit = map.get(sessionID)
    if (hit) return hit
    let data = empty()
    try {
      const Session = await sessionApi()
      const session = await Session.get(sessionID)
      data = fromSession(session?.rules)
    } catch {
      data = empty()
    }
    map.set(sessionID, data)
    return data
  }

  async function persist(sessionID: string, data: Data) {
    try {
      const Session = await sessionApi()
      await Session.update(
        sessionID,
        (draft) => {
          draft.rules = {
            pinned: data.pinned.map((item) => ({ ...item })),
            recentFiles: data.recentFiles.map((item) => ({ ...item })),
            userTurns: [...data.userTurns],
          }
        },
        { touch: false },
      )
    } catch {
      // The session is not stored yet, or this is a fake id in a unit test: keep only the in-process cache
    }
  }

  async function mutate(sessionID: string, editor: (data: Data) => void) {
    const data = await load(sessionID)
    editor(data)
    cache().bySession.set(sessionID, data)
    await persist(sessionID, data)
    return data
  }

  export async function snapshot(sessionID: string): Promise<Data> {
    const data = await load(sessionID)
    return {
      pinned: data.pinned.map((item) => ({ ...item })),
      recentFiles: data.recentFiles.map((item) => ({ ...item })),
      userTurns: [...data.userTurns],
    }
  }

  export async function noteUserTurn(sessionID: string, userMessageID: string) {
    if (Flag.MERAKCODE_DISABLE_RULES) return
    await mutate(sessionID, (data) => {
      if (data.userTurns[data.userTurns.length - 1] === userMessageID) return
      data.userTurns.push(userMessageID)
      if (data.userTurns.length > USER_TURN_CAP) data.userTurns.splice(0, data.userTurns.length - USER_TURN_CAP)
    })
  }

  export async function recordFile(sessionID: string, filepath: string, userMessageID: string) {
    if (Flag.MERAKCODE_DISABLE_RULES) return
    const resolved = path.resolve(filepath)
    await mutate(sessionID, (data) => {
      data.recentFiles = data.recentFiles.filter((item) => item.path !== resolved)
      data.recentFiles.push({ path: resolved, userMessageID })
      if (data.recentFiles.length > RECENT_FILE_CAP) {
        data.recentFiles.splice(0, data.recentFiles.length - RECENT_FILE_CAP)
      }
    })
  }

  export function userMessageIDFrom(messages: Message.FullMsg[]) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === "user") return messages[i].info.id
    }
  }

  export async function touchFromTool(ctx: { sessionID: string; messages: Message.FullMsg[] }, filepath: string) {
    const userMessageID = userMessageIDFrom(ctx.messages)
    if (!userMessageID) return
    await recordFile(ctx.sessionID, filepath, userMessageID)
  }

  export async function pin(sessionID: string, filepath: string, source: PinSource) {
    if (Flag.MERAKCODE_DISABLE_RULES) return
    const resolved = path.resolve(filepath)
    await mutate(sessionID, (data) => {
      if (data.pinned.some((item) => Filesystem.sameFilepath(item.filepath, resolved))) return
      data.pinned.push({ filepath: resolved, source })
    })
  }

  /**
   * Handles a user @-mention of a file: manual and agent-requested rules are pinned, always and auto rule files skip
   * the synthetic Read, and other files are pre-read as usual.
   */
  export async function handleMention(input: {
    sessionID: string
    userMessageID: string
    filepath: string
  }): Promise<MentionAction> {
    if (Flag.MERAKCODE_DISABLE_RULES) return "file"
    const rule = RuleMatch.byFilepath(await Rule.all(), input.filepath)
    if (!rule) return "file"
    if (rule.type === "always" || rule.type === "auto") return "skip"
    if (rule.type === "manual" || rule.type === "agent-requested") {
      await pin(input.sessionID, rule.filepath, "mention")
      return "pin"
    }
    return "file"
  }

  export async function prunePins(sessionID: string, filepaths: string[]) {
    if (filepaths.length === 0) return
    await mutate(sessionID, (data) => {
      data.pinned = data.pinned.filter(
        (item) => !filepaths.some((filepath) => Filesystem.sameFilepath(item.filepath, filepath)),
      )
    })
  }

  export function invalidate(sessionID: string) {
    cache().bySession.delete(sessionID)
  }
}
