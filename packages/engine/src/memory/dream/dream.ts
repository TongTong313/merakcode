import { Log } from "@merakcode/log/logger"
import { Bus } from "../../bus"
import { Config } from "../../config/config"
import { NotifyEvent } from "../../notify/event"
import { Instance } from "../../project/instance"
import { Session } from "../../session"
import type { Message } from "../../session/message"
import { MemoryAccess } from "../access"
import { MemoryPath } from "../path"
import { localDate, pickMemoryModel, resolveExtractPolicy } from "../util"
import { buildConsolidationPrompt } from "./consolidation-prompt"
import { Text } from "../../util/text"
import {
  listSessionsTouchedSince,
  readLastConsolidatedAt,
  rollbackConsolidationLock,
  tryAcquireConsolidationLock,
} from "./consolidation-lock"

/**
 * AutoDream (memory consolidation).
 *
 * Periodically forks a child session that reviews the memory directory and merges, deduplicates, refines and prunes
 * the index, turning the fragments MemoryExtract accumulates into organized, current long-term memory.
 *
 * Related subsystems:
 * - MemoryExtract writes new fragments every turn
 * - AutoDream periodically consolidates them
 * - SessionMemory keeps per-session notes and is independent of AutoDream
 *
 * Three gates, cheapest first:
 *   1. time: at least minHours since the last consolidation (one stat)
 *   2. sessions: at least minSessions sessions updated since then (scans Session.list)
 *   3. lock: no other process is consolidating
 *
 * The lock file mtime is lastConsolidatedAt, so one stat reads both the lock state and the timestamp.
 *
 * The child session is forked with Session.forkAsChild (no prompt cache sharing), configured from Config.memory, and
 * reuses MemoryAccess.extractorRules() (bash denied; read/grep/glob/ls and memory directory writes allowed).
 */
export namespace AutoDream {
  const log = Log.create({ service: "memory.dream" })
  const DREAMER_AGENT = "memory-dreamer"
  const DREAM_TITLE = "memory consolidation"

  const DEFAULTS = { minHours: 24, minSessions: 5 }
  /** Once the time gate passes but the session gate does not, avoids rescanning sessions every turn */
  const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000

  // Gates are pure functions for unit tests; run applies them in order: time, scan throttle, sessions, lock.
  /** Passes when at least minHours have passed since the last consolidation */
  export function timeGatePassed(now: number, lastAt: number, minHours: number): boolean {
    return (now - lastAt) / 3_600_000 >= minHours
  }
  /** Passes when at least minSessions sessions were updated since the last consolidation */
  export function sessionGatePassed(count: number, minSessions: number): boolean {
    return count >= minSessions
  }
  /** Passes when the lock is free (tryAcquire returned non-null) */
  export function lockAvailable(lockResult: number | null): boolean {
    return lockResult !== null
  }

  type Input = {
    session: Session.Info
    assistant: Message.AssistantInfo
    model: Message.UserInfo["model"]
  }

  /** Per-instance state, which keeps tests isolated */
  const state = Instance.state(() => ({
    lastSessionScanAt: 0,
    inFlight: undefined as Promise<void> | undefined,
  }))

  /**
   * Entry point, called fire-and-forget by the runner at the end of a turn (next to MemoryExtract.schedule).
   * Costs one stat per turn when enabled, plus an occasional session scan.
   *
   * inFlight is assigned synchronously here. If run set it after an await, another schedule call during the gate I/O
   * would see it empty and start a second run; the lock would still keep consolidation unique, but the extra scans
   * are wasted.
   */
  export function schedule(input: Input) {
    if (input.session.parentID) return // not for child sessions
    if (input.assistant.error) return // not after failed turns
    const s = state()
    if (s.inFlight) return // a consolidation is already running; skip rather than queue
    s.inFlight = run(input)
      .catch((error) => log.warn("auto dream failed", { error }))
      .finally(() => {
        s.inFlight = undefined
      })
  }

  async function run(input: Input): Promise<void> {
    if (!Instance.has()) return
    const mem = (await Config.get()).memory
    if (!mem?.auto_dream) return
    // With extraction off there is nothing to consolidate
    if (resolveExtractPolicy(mem.auto_extract) === "off") return
    const minHours =
      typeof mem.dream_min_hours === "number" && mem.dream_min_hours > 0 ? mem.dream_min_hours : DEFAULTS.minHours
    const minSessions =
      typeof mem.dream_min_sessions === "number" && mem.dream_min_sessions > 0
        ? mem.dream_min_sessions
        : DEFAULTS.minSessions

    // Gate 1: time (cheapest, one stat)
    let lastAt: number
    try {
      lastAt = await readLastConsolidatedAt()
    } catch (error) {
      log.warn("readLastConsolidatedAt failed", { error })
      return
    }
    if (!timeGatePassed(Date.now(), lastAt, minHours)) return

    // Scan throttle: while the session gate keeps failing, the lock mtime does not advance and the time gate passes
    // every turn, so throttle the session scan.
    const s = state()
    const sinceScanMs = Date.now() - s.lastSessionScanAt
    if (sinceScanMs < SESSION_SCAN_INTERVAL_MS) {
      log.info("scan throttle - time-gate passed but last scan was recent", {
        sinceScanSec: Math.round(sinceScanMs / 1000),
      })
      return
    }
    s.lastSessionScanAt = Date.now()

    // Gate 2: session count (scans Session.list)
    let sessionIds: string[]
    try {
      sessionIds = await listSessionsTouchedSince(lastAt)
    } catch (error) {
      log.warn("listSessionsTouchedSince failed", { error })
      return
    }
    // Exclude the current session, whose time.updated is always the newest
    sessionIds = sessionIds.filter((id) => id !== input.session.id)
    if (!sessionGatePassed(sessionIds.length, minSessions)) {
      log.info("skip - not enough sessions since last consolidation", {
        sessions: sessionIds.length,
        need: minSessions,
      })
      return
    }

    // Gate 3: lock (most expensive)
    let priorMtime: number | null
    try {
      priorMtime = await tryAcquireConsolidationLock()
    } catch (error) {
      log.warn("lock acquire failed", { error })
      return
    }
    if (!lockAvailable(priorMtime)) return
    // lockAvailable guarantees priorMtime is a number
    const lockMtime = priorMtime as number

    log.info("auto dream firing", {
      hoursSince: ((Date.now() - lastAt) / 3_600_000).toFixed(1),
      sessions: sessionIds.length,
    })

    // inFlight stays set meanwhile, so a concurrent schedule cannot start a second run
    await runConsolidation(input, sessionIds, lockMtime)
    // Notify the TUI; this is rare enough to need no throttling
    const lang = await Text.lang()
    await Bus.publish(NotifyEvent.ToastShow, {
      title: Text.format({ zh: "记忆巩固", en: "Memory consolidation" }, lang),
      message: Text.format(
        {
          zh: "AutoDream 已完成，审查了 {count} 个会话的记忆。",
          en: "AutoDream finished and reviewed memories from {count} session(s).",
        },
        lang,
        { count: sessionIds.length },
      ),
      variant: "success",
    }).catch(() => undefined)
    log.info("auto dream completed", { sessionsReviewed: sessionIds.length })
  }

  async function runConsolidation(input: Input, sessionIds: string[], priorMtime: number) {
    try {
      const memoryDir = MemoryPath.directory()
      // extractorRules denies bash, so tell the model to explore with grep/glob/ls/read
      const extra = [
        "",
        `**Tool constraints:** Bash is disabled. Use \`grep\` / \`glob\` / \`ls\` / \`read\` to explore.`,
        `Sessions since the last consolidation (${sessionIds.length}):`,
        ...sessionIds.map((id) => `- ${id}`),
      ].join("\n")
      const prompt = buildConsolidationPrompt(memoryDir, extra, localDate())

      const child = await Session.forkAsChild({
        sessionID: input.session.id,
        parentID: input.session.id,
        title: DREAM_TITLE,
        permission: MemoryAccess.extractorRules(),
      })
      const { SessionRunner } = await import("../../session/runner")
      await SessionRunner.promptGenerated({
        sessionID: child.id,
        agent: DREAMER_AGENT,
        model: await pickMemoryModel(input.model),
        permissionMode: "ask",
        maxTurns: 15, // more than extraction (5): consolidation reads many files and edits in parallel
        parts: [
          {
            type: "text",
            text: prompt,
            synthetic: true,
          },
        ],
      })
      // On success the lock mtime already advanced to now during acquire
      log.info("auto dream completed", { sessionsReviewed: sessionIds.length })
    } catch (error) {
      // Roll back the lock mtime so the time gate passes again next time; the scan throttle acts as backoff
      await rollbackConsolidationLock(priorMtime)
      throw error
    }
  }

  /**
   * Waits for an in-flight consolidation before the process exits so the forked child session is not killed
   * midway. Best effort: gives up after the timeout.
   */
  export async function drain(timeoutMs = 5_000): Promise<void> {
    const inflight = state().inFlight
    if (!inflight) return
    await Promise.race([inflight.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, timeoutMs))])
  }
}
