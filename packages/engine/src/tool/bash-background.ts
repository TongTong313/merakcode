import z from "zod"
import type { ChildProcess } from "child_process"
import { Tool } from "./tool"
import DESCRIPTION from "./bash-background.txt"
import { Log } from "@merakcode/log/logger"
import { Shell } from "../shell/shell"
import { randomUUID } from "crypto"
import { prepareBashCommand, SandboxEscalation, spawnCommand } from "./bash"
import { Session } from "../session"
import { Message } from "../session/message"
import { SessionExecution } from "../session/execution"
import { Config } from "../config/config"
import { Redact } from "../util/redact"

const log = Log.create({ service: "bash-background" })

export type JobStatus = "running" | "completed" | "failed" | "stopped"

export type BashJob = {
  id: string
  command: string
  description: string
  cwd: string
  pid: number | undefined
  status: JobStatus
  exitCode: number | null
  log: string
  startedAt: number
  endedAt: number | null
  /**
   * Needed to report completion: finish uses sessionID/messageID/callID to find the original tool part and update
   * its metadata, and sessionID to send a synthetic user message through SessionRunner.prompt.
   * When they are missing (jobs built directly in unit tests), finish skips the notification.
   */
  sessionID?: string
  messageID?: string
  callID?: string
}

const MAX_LOG_BYTES = 500_000
const MAX_JOBS = 50
const MAX_RUNNING_JOBS = 10
const NOTIFY_TAIL_BYTES = 2_000
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000
const STALL_CHECK_INTERVAL_MS = 5_000
const STALL_THRESHOLD_MS = 45_000
const STALL_TAIL_BYTES = 1_024

const PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
]

export function looksLikePrompt(text: string): boolean {
  const lastLine = text.trimEnd().split("\n").pop() ?? ""
  return PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine))
}

export namespace BashJobStore {
  const jobs = new Map<string, BashJob>()
  const procs = new Map<string, ChildProcess>()
  const timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const stallTimers = new Map<string, ReturnType<typeof setInterval>>()

  export function get(id: string): BashJob | undefined {
    return jobs.get(id)
  }

  export function list(): BashJob[] {
    return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  export function clear() {
    for (const id of jobs.keys()) clearTimers(id)
    for (const proc of procs.values()) {
      if (!proc.killed) proc.kill()
    }
    jobs.clear()
    procs.clear()
  }

  export async function stop(id: string): Promise<boolean> {
    const job = jobs.get(id)
    if (!job || job.status !== "running") return false
    const proc = procs.get(id)
    if (proc) {
      // Kills the process tree: SIGTERM/SIGKILL to the group on Linux and macOS, taskkill /T on Windows
      await Shell.killTree(proc).catch(() => undefined)
    }
    job.status = "stopped"
    job.endedAt = Date.now()
    clearTimers(id)
    return true
  }
  function clearTimers(id: string) {
    const timeout = timeoutTimers.get(id)
    if (timeout) clearTimeout(timeout)
    timeoutTimers.delete(id)
    const stall = stallTimers.get(id)
    if (stall) clearInterval(stall)
    stallTimers.delete(id)
  }

  function startTimeout(id: string, timeoutMs: number) {
    if (timeoutMs <= 0) return
    const timer = setTimeout(() => {
      const job = jobs.get(id)
      if (!job || job.status !== "running") return
      append(
        id,
        `\n\n<bash_metadata>\nBackground bash job terminated after exceeding timeout ${timeoutMs} ms\n</bash_metadata>`,
      )
      void stop(id)
    }, timeoutMs)
    timer.unref?.()
    timeoutTimers.set(id, timer)
  }

  function startStallWatchdog(id: string) {
    let lastLength = 0
    let lastGrowth = Date.now()
    let notified = false
    const timer = setInterval(() => {
      const job = jobs.get(id)
      if (!job || job.status !== "running") {
        clearTimers(id)
        return
      }
      if (job.log.length > lastLength) {
        lastLength = job.log.length
        lastGrowth = Date.now()
        return
      }
      if (notified || Date.now() - lastGrowth < STALL_THRESHOLD_MS) return
      const recent = tail(job.log, STALL_TAIL_BYTES)
      if (!looksLikePrompt(recent)) {
        lastGrowth = Date.now()
        return
      }
      notified = true
      append(
        id,
        "\n\n<bash_metadata>\nBackground bash job appears to be waiting for interactive input. Stop it and re-run with piped input or a non-interactive flag.\n</bash_metadata>",
      )
    }, STALL_CHECK_INTERVAL_MS)
    timer.unref?.()
    stallTimers.set(id, timer)
  }

  export async function stopAll(): Promise<void> {
    await Promise.all([...jobs.values()].filter((job) => job.status === "running").map((job) => stop(job.id)))
  }

  export function running(): BashJob[] {
    return [...jobs.values()].filter((job) => job.status === "running")
  }

  export function create(params: {
    command: string
    description: string
    cwd: string
    proc: ChildProcess
    timeoutMs?: number
    sessionID?: string
    messageID?: string
    callID?: string
  }): BashJob {
    const running = [...jobs.values()].filter((job) => job.status === "running").length
    if (running >= MAX_RUNNING_JOBS) {
      throw new Error(
        `Too many running bash background jobs (${running}). Stop an existing job before starting another.`,
      )
    }
    // Above MAX_JOBS, drop the oldest finished job; running jobs are kept
    if (jobs.size >= MAX_JOBS) {
      for (const [oldId, old] of jobs) {
        if (old.status !== "running") {
          jobs.delete(oldId)
          procs.delete(oldId)
          break
        }
      }
    }
    const id = "job_" + randomUUID().replace(/-/g, "").slice(0, 16)
    const job: BashJob = {
      id,
      command: params.command,
      description: params.description,
      cwd: params.cwd,
      pid: params.proc.pid,
      status: "running",
      exitCode: null,
      log: "",
      startedAt: Date.now(),
      endedAt: null,
      sessionID: params.sessionID,
      messageID: params.messageID,
      callID: params.callID,
    }
    jobs.set(id, job)
    procs.set(id, params.proc)
    startTimeout(id, params.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS)
    startStallWatchdog(id)
    return job
  }

  export function append(id: string, chunk: string) {
    const job = jobs.get(id)
    if (!job) return
    job.log += chunk
    if (job.log.length > MAX_LOG_BYTES) {
      job.log = job.log.slice(job.log.length - MAX_LOG_BYTES)
    }
  }

  export function finish(id: string, exitCode: number | null, status: JobStatus) {
    const job = jobs.get(id)
    if (!job) return
    job.exitCode = exitCode
    job.status = status
    job.endedAt = Date.now()
    procs.delete(id)
    clearTimers(id)
    // Only jobs started by a real tool call carry this context; jobs built in unit tests have none
    if (job.sessionID && job.messageID && job.callID) {
      void notifyAgent(job).catch((e) => log.warn("notify failed", { id, error: String(e) }))
    }
  }
}

/**
 * Runs when a background job ends:
 *   1. Updates state.metadata of the original tool part so the UI card moves from running to its final state and
 *      the stop button goes away.
 *   2. Sends a synthetic user message through SessionRunner.prompt so the agent sees the result on its next loop.
 *      SessionRunner queues it while the session is busy and runs it right away when idle.
 *
 * Failures are caught and logged: the session may have been deleted or aborted, and that must not make BashJobStore
 * throw and affect other jobs.
 */
async function notifyAgent(job: BashJob) {
  if (!job.sessionID || !job.messageID || !job.callID) return

  // The UI reads state.metadata.status to tell whether the job is still running
  try {
    const parts = await Message.parts({ sessionID: job.sessionID, messageID: job.messageID })
    const part = parts.find((p) => p.type === "tool" && (p as Message.ToolPart).callID === job.callID) as
      Message.ToolPart | undefined
    if (part && part.state.status === "completed") {
      await Session.updatePart({
        ...part,
        state: {
          ...part.state,
          metadata: {
            ...part.state.metadata,
            status: job.status,
            exit: job.exitCode,
            output: tail(job.log, NOTIFY_TAIL_BYTES),
          },
        },
      })
    }
  } catch (e) {
    log.warn("update part metadata failed", { id: job.id, error: String(e) })
  }

  // Dynamic import breaks the bash-background → ToolRegistry → SessionRunner import cycle
  try {
    const { SessionRunner } = await import("../session/runner")
    const sessionID = job.sessionID
    const summary = buildJobSummary(job)
    const text = (await Config.get()).sandbox?.redactSecrets !== false ? Redact.secrets(summary) : summary
    // Child-process exit callbacks retain the spawning request's async context.
    // This completion notification is a new turn, independent of that request.
    await SessionExecution.run(undefined, () =>
      SessionRunner.prompt({
        sessionID,
        parts: [{ type: "text", text }],
      }),
    )
  } catch (e) {
    log.info("notify prompt skipped", { id: job.id, error: String(e) })
  }
}

function tail(text: string, bytes: number): string {
  if (text.length <= bytes) return text
  return "...(truncated)...\n" + text.slice(-bytes)
}

function buildJobSummary(job: BashJob): string {
  return [
    `[Background bash job ${job.id} finished]`,
    `Command: ${job.command}`,
    `Description: ${job.description}`,
    `Status: ${job.status}`,
    `Exit code: ${job.exitCode ?? "n/a"}`,
    "Tail output:",
    "```",
    tail(job.log, NOTIFY_TAIL_BYTES) || "(no output)",
    "```",
  ].join("\n")
}

export const BashBackgroundTool = Tool.define(
  "bash_background",
  async () => {
    const shell = Shell.acceptable()

    return {
      description: DESCRIPTION,
      parameters: z.object({
        command: z.string().describe("The bash command to run in the background"),
        description: z.string().describe("Short description of what this background job does (5-10 words)"),
        timeout: z.number().describe("Optional timeout in milliseconds for the background job").optional(),
        workdir: z.string().describe("Working directory for the command. Defaults to the project root.").optional(),
        ...SandboxEscalation,
      }),
      async execute(params, ctx) {
        if (params.timeout !== undefined && params.timeout < 0) {
          throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
        }
        // Same approval and sandbox as bash, for the whole job lifetime. readOnly is deliberately ignored and the
        // FileTime write barrier is not taken: background jobs (dev servers, watchers) keep running, and holding the
        // barrier would block every edit / write forever. The cost is no protection when a background command and an
        // edit write the same file at once; callers have to manage that themselves.
        const { cwd, shellEnv, sandbox } = await prepareBashCommand(params, ctx)
        const { proc, finish } = await spawnCommand({
          command: params.command,
          shell,
          cwd,
          env: shellEnv,
          ctx,
          sandbox,
        })

        const job = BashJobStore.create({
          command: params.command,
          description: params.description,
          cwd,
          proc,
          timeoutMs: params.timeout,
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
        })

        log.info("starting background job", { id: job.id, command: params.command })

        const append = (chunk: Buffer) => BashJobStore.append(job.id, chunk.toString())
        proc.stdout?.on("data", append)
        proc.stderr?.on("data", append)

        proc.once("exit", (code) => {
          // Operations the sandbox blocked go into the job log, so the agent sees them in the completion notice
          const violations = finish("", code)
          if (violations) BashJobStore.append(job.id, violations)
          const status: JobStatus = (() => {
            if (job.status === "stopped") return "stopped"
            return code === 0 ? "completed" : "failed"
          })()
          BashJobStore.finish(job.id, code, status)
          log.info("background job ended", { id: job.id, code, status })
        })

        proc.once("error", (err) => {
          finish("")
          BashJobStore.append(job.id, `\nError: ${err.message}`)
          BashJobStore.finish(job.id, null, "failed")
        })

        ctx.metadata({
          title: params.description,
          metadata: { jobId: job.id, status: "running", command: params.command },
        })

        return {
          title: params.description,
          metadata: { jobId: job.id, status: "running", command: params.command },
          output:
            `Background job started.\nJob ID: ${job.id}\nCommand: ${params.command}\n` +
            `The job will notify you with its final status and output when it exits; ` +
            `do not poll, just continue with other tasks.`,
        }
      },
    }
  },
  "后台 后台运行 后台任务 后台执行 长时间运行 开发服务器 dev server watch 监听 long-running background watcher",
)
