import { createHash } from "crypto"
import { Script, createContext } from "vm"
import { ulid } from "ulid"
import { Agent, STANDARD_TOOL_POOL } from "../agent/agent"
import { Bus } from "../bus"
import { Identifier } from "@merakcode/util/id"
import { PermissionNext } from "../permission/next"
import { Provider } from "../provider/provider"
import { Session } from "../session"
import { Message } from "../session/message"
import { SessionRunner } from "../session/runner"
import { ToolRegistry } from "../tool/registry"
import { defer } from "@merakcode/util/defer"
import type {
  WorkflowAgentOptions,
  WorkflowAgentProgress,
  WorkflowLogProgress,
  WorkflowRunCache,
  WorkflowRunCacheEntry,
  WorkflowRunMetadata,
  WorkflowScript,
  WorkflowAgentToolProgress,
  WorkflowWorkUnit,
  WorkflowRunControl,
} from "./types"
import { WorkflowRegistry } from "./registry"
import { WorkflowState } from "./state"

type Hooks = {
  update(metadata: WorkflowRunMetadata): Promise<void>
  runNested?(name: string, args: unknown): Promise<unknown>
}

type RuntimeInput = {
  script: WorkflowScript
  args: unknown
  sessionID: string
  messageID: string
  runId?: string
  abort: AbortSignal
  control?: WorkflowRunControl
  defaultModel: { providerID: string; modelID: string }
  callerRuleset?: PermissionNext.Ruleset
  resume?: WorkflowRunCache
  hooks: Hooks
}

export const MAX_TOTAL_WORKFLOW_AGENTS = 1000
const DEFAULT_WORKFLOW_PHASE = "Workflow"
const TOOL_PROGRESS_UPDATE_INTERVAL = 200
const STRING_RESULT_COMPAT_PRELUDE = `
// Temporary compatibility for older workflow scripts that treated text agent results
// as { content/text/output }. Host String.prototype is not modified.
Object.defineProperties(String.prototype, {
  content: { configurable: true, get() { return String(this) } },
  text: { configurable: true, get() { return String(this) } },
  output: { configurable: true, get() { return String(this) } },
});
`

class WorkflowSemaphore {
  private inflight = 0
  private waiters: Array<() => void> = []

  constructor(private readonly capacity: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError")
    if (this.inflight < this.capacity) {
      this.inflight++
      return () => this.release()
    }
    return new Promise<() => void>((resolve, reject) => {
      const grant = () => {
        if (signal.aborted) return
        this.inflight++
        cleanup()
        resolve(() => this.release())
      }
      const onAbort = () => {
        const index = this.waiters.indexOf(grant)
        if (index >= 0) this.waiters.splice(index, 1)
        cleanup()
        reject(new DOMException("aborted", "AbortError"))
      }
      const cleanup = () => signal.removeEventListener("abort", onAbort)
      this.waiters.push(grant)
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  private release() {
    this.inflight--
    const next = this.waiters.shift()
    if (next) next()
  }
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function stringify(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

function messageFrom(result: Message.FullMsg) {
  return result.parts.findLast((part) => part.type === "text")?.text ?? ""
}

function clone<T>(input: T): T {
  return input === undefined ? input : JSON.parse(JSON.stringify(input))
}

function text(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function compact(value: unknown, limit = 240) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  if (!text) return undefined
  return text.length > limit ? text.slice(0, limit) + "..." : text
}

function optionList(value: unknown) {
  if (!Array.isArray(value)) return undefined
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).toSorted()
}

function toolAllowlistItems(opts: WorkflowAgentOptions) {
  return optionList(opts.allowedTools) ?? optionList(opts.tools)
}

function cacheOptions(opts: WorkflowAgentOptions) {
  const allowlist = toolAllowlistItems(opts)
  const {
    kind: _kind,
    maxTurns: _maxTurns,
    isolation: _isolation,
    allowedTools: _allowedTools,
    tools: _tools,
    ...safe
  } = opts
  return {
    ...safe,
    ...(allowlist ? { allowedTools: allowlist } : {}),
  }
}

async function buildToolRestrictions(agent: Agent.Info, opts: WorkflowAgentOptions) {
  const allowlist = toolAllowlistItems(opts)
  if (!allowlist) return { ruleset: [] as PermissionNext.Ruleset }

  const allowed = new Set(allowlist)
  const pool = new Set<string>(agent.profile?.availableTools ?? STANDARD_TOOL_POOL)
  const standard = new Set<string>(STANDARD_TOOL_POOL)
  const registered = new Set(await ToolRegistry.ids())
  const dynamic = await ToolRegistry.dynamicIds()
  const restrictable = Array.from(
    new Set([
      ...Array.from(pool).filter((tool) => standard.has(tool) || registered.has(tool)),
      ...(pool.has("plugin") ? Array.from(dynamic) : []),
    ]),
  ).toSorted()
  const denied = restrictable.filter((tool) => !allowed.has(tool))

  return {
    tools: Object.fromEntries(denied.map((tool) => [tool, false])),
    ruleset: denied.map((tool) => ({
      permission: tool,
      pattern: "*",
      action: "deny" as const,
    })),
  }
}

function toolProgress(part: Message.ToolPart): WorkflowAgentToolProgress {
  const state = part.state
  const title = state.status === "running" || state.status === "completed" ? state.title : undefined
  const summary =
    state.status === "error"
      ? state.error
      : state.status === "completed"
        ? compact(state.output)
        : state.status === "pending"
          ? compact(state.raw)
          : compact(state.metadata)
  return {
    tool: part.tool,
    callID: part.callID,
    status: state.status,
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(state.status === "running" || state.status === "completed" || state.status === "error"
      ? { startedAt: state.time.start }
      : {}),
    ...(state.status === "completed" || state.status === "error" ? { completedAt: state.time.end } : {}),
    updatedAt: Date.now(),
  }
}

export namespace WorkflowRuntime {
  const SANDBOX_MISSING_GLOBALS = new Set([
    "require",
    "module",
    "exports",
    "process",
    "Bun",
    "global",
    "__dirname",
    "__filename",
    "fs",
    "path",
  ])

  /**
   * Explains "X is not defined" errors caused by globals missing from the vm sandbox, and suggests using a subagent
   * to read and write files. Workflow scripts run in a restricted vm sandbox (see createContext in run()) that only
   * exposes hooks such as agent/fanout/pipeline, so a model using require/process/fs gets a bare ReferenceError.
   * Only known Node globals get the note; misspelled variables keep the original message so it is not misleading.
   */
  export function explainWorkflowError(message: string): string {
    const matched = /^(?:\w+Error:\s*)?([A-Za-z_$][\w$]*) is not defined/.exec(message)
    const name = matched?.[1]
    if (name && SANDBOX_MISSING_GLOBALS.has(name)) {
      return `${message}. Workflow scripts run in a restricted sandbox that only exposes agent/fanout/pipeline/parallel/phase/log/args/budget — Node.js/host APIs such as require, process, fs, and Bun are not available. To read or write files, have a child agent do it with its normal tools instead of using them directly in the script.`
    }
    return message
  }

  /**
   * Normalizes the result of agent(): when a schema was requested but no structured output arrived, returns a
   * failure (the caller marks the agent failed and throws) instead of silently falling back to text or an empty
   * string, which would make the workflow succeed with an empty result.
   */
  export function resolveAgentOutput(input: {
    schemaRequested: boolean
    role: string
    structured: unknown
    text: string
    error: unknown
  }): { ok: true; output: unknown } | { ok: false; error: string } {
    if (input.schemaRequested && input.role === "assistant") {
      if (input.structured !== undefined) return { ok: true, output: input.structured }
      const detail =
        (input.error as { data?: { message?: unknown } } | undefined)?.data?.message ??
        (input.error as { message?: unknown } | undefined)?.message
      return {
        ok: false,
        error:
          typeof detail === "string" && detail.trim()
            ? `Structured output failed: ${detail.trim()}`
            : "Structured output failed: child agent did not produce structured output for the requested schema",
      }
    }
    return { ok: true, output: input.text }
  }

  export async function run(input: RuntimeInput) {
    const runId = input.runId ?? ulid()
    const createdAt = Date.now()
    const cache: WorkflowRunCache = {
      version: 1,
      runId,
      workflowName: input.script.name,
      scriptPath: input.script.scriptPath,
      entries: [],
    }
    const prior = input.resume?.entries ?? []
    const phases = input.script.phases.length ? input.script.phases : [{ title: DEFAULT_WORKFLOW_PHASE }]
    const maxConcurrentAgents = input.script.maxConcurrentAgents ?? input.script.concurrency
    const semaphore = maxConcurrentAgents ? new WorkflowSemaphore(maxConcurrentAgents) : undefined
    let dynamicConcurrentAgents: number | undefined
    let agentCount = 0
    let phase = phases[0]?.title
    const agents: WorkflowAgentProgress[] = []
    const workUnits: WorkflowWorkUnit[] = []
    const workUnitsById = new Map<string, WorkflowWorkUnit>()
    const logs: WorkflowLogProgress[] = []
    const callerPermissionHash = hash(input.callerRuleset ?? [])
    const count = (status: WorkflowAgentProgress["status"]) => agents.filter((item) => item.status === status).length
    const signal = input.control?.abort.signal ?? input.abort
    const check = () => signal.throwIfAborted()
    const metadata = (status: WorkflowRunMetadata["status"], extra: Partial<WorkflowRunMetadata> = {}) => {
      const now = Date.now()
      return {
        status,
        workflowName: input.script.name,
        description: input.script.description,
        runId,
        messageID: input.messageID,
        scriptPath: input.script.scriptPath,
        phase,
        phases,
        agents: clone(agents),
        workUnits: clone(workUnits),
        logs: clone(logs),
        resumable: true,
        createdAt,
        updatedAt: now,
        ...(status === "completed" || status === "failed" || status === "aborted" ? { completedAt: now } : {}),
        ...((maxConcurrentAgents ?? dynamicConcurrentAgents)
          ? { maxConcurrentAgents: maxConcurrentAgents ?? dynamicConcurrentAgents }
          : {}),
        maxTotalAgents: MAX_TOTAL_WORKFLOW_AGENTS,
        agentCount: agents.length,
        queuedAgentCount: count("queued"),
        runningAgentCount: count("running"),
        completedAgentCount: count("completed"),
        failedAgentCount: count("failed"),
        cachedAgentCount: count("cached"),
        ...extra,
      }
    }
    const update = (status: WorkflowRunMetadata["status"] = "running", extra: Partial<WorkflowRunMetadata> = {}) =>
      input.hooks.update(metadata(status, extra))

    await update()

    const agent = async (prompt: string, opts: WorkflowAgentOptions = {}) => {
      agentCount++
      if (agentCount > MAX_TOTAL_WORKFLOW_AGENTS)
        throw new Error(`Workflow exceeded ${MAX_TOTAL_WORKFLOW_AGENTS} agent calls`)
      const id = `agent-${agentCount}`
      const agentID = opts.agent ?? opts.agentType ?? "workflow-subagent"
      const label = opts.label ?? (prompt.split(/\s+/).slice(0, 5).join(" ") || id)
      const currentPhase = phases.find((item) => item.title === (opts.phase ?? phase))
      const entry: WorkflowAgentProgress = {
        id,
        label,
        phase: opts.phase ?? phase,
        agent: agentID,
        status: "queued",
      }
      agents.push(entry)
      if (opts.workUnitId) {
        const unit = workUnitsById.get(opts.workUnitId)
        if (unit) {
          unit.agentId = id
          unit.status = "queued"
        }
      }
      await update()

      const callHash = hash({
        prompt,
        opts: cacheOptions(opts),
        args: input.args,
        script: input.script.script,
        callerPermissionHash,
        index: agentCount,
      })
      const cached = prior.find((item) => item.hash === callHash)
      if (cached) {
        entry.status = "cached"
        entry.sessionId = cached.agent.sessionId
        entry.model = cached.agent.model
        entry.startedAt = cached.agent.startedAt
        entry.completedAt = Date.now()
        if (opts.workUnitId) {
          const unit = workUnitsById.get(opts.workUnitId)
          if (unit) unit.status = "cached"
        }
        cache.entries.push(cached)
        await update()
        return cached.result
      }

      const release = semaphore ? await semaphore.acquire(signal) : () => {}
      let updatePending: Promise<void> = Promise.resolve()
      let updateTimer: ReturnType<typeof setTimeout> | undefined
      let updateScheduled = false
      const toolCalls = new Set<string>()
      const writeQueuedUpdate = () => {
        updatePending = updatePending.then(() => update()).catch(() => undefined)
        return updatePending
      }
      const queueUpdate = () => {
        if (updateScheduled) return
        updateScheduled = true
        updateTimer = setTimeout(() => {
          updateTimer = undefined
          updateScheduled = false
          void writeQueuedUpdate()
        }, TOOL_PROGRESS_UPDATE_INTERVAL)
      }
      const flushUpdate = async () => {
        if (updateTimer) {
          clearTimeout(updateTimer)
          updateTimer = undefined
          updateScheduled = false
          await writeQueuedUpdate()
          return
        }
        await updatePending
      }
      try {
        const info = await Agent.get(agentID)
        if (!info) throw new Error(`Unknown workflow agent: ${agentID}`)
        const model = opts.model
          ? Provider.parseModel(opts.model)
          : currentPhase?.model
            ? Provider.parseModel(currentPhase.model)
            : (info.model ?? input.defaultModel)
        entry.model = model
        entry.status = "running"
        entry.startedAt = Date.now()
        if (opts.workUnitId) {
          const unit = workUnitsById.get(opts.workUnitId)
          if (unit) unit.status = "running"
        }
        await update()
        const restrictions = await buildToolRestrictions(info, opts)
        const childPermission = PermissionNext.mergeUnique(input.callerRuleset ?? [], restrictions.ruleset)
        const child = await Session.create({
          parentID: input.sessionID,
          title: `${label} (@${agentID} workflow)`,
          ...(childPermission.length ? { permission: clone(childPermission) } : {}),
        })
        entry.sessionId = child.id
        await update()
        const unsubscribe = Bus.subscribe(Message.Event.PartUpdated, (event) => {
          const part = event.properties.part
          if (part.sessionID !== child.id || part.type !== "tool") return
          toolCalls.add(part.callID)
          entry.toolCount = toolCalls.size
          entry.latestTool = toolProgress(part)
          queueUpdate()
        })
        const cancel = () => SessionRunner.cancel(child.id)
        signal.addEventListener("abort", cancel)
        using _ = defer(() => {
          signal.removeEventListener("abort", cancel)
          unsubscribe()
        })
        const result = await SessionRunner.prompt({
          sessionID: child.id,
          messageID: Identifier.ascending("message"),
          agent: agentID,
          model,
          kind: "ask",
          ...(restrictions.tools ? { tools: restrictions.tools } : {}),
          format: opts.schema
            ? {
                type: "json_schema",
                schema: opts.schema,
                retryCount: 2,
              }
            : undefined,
          parts: await SessionRunner.resolvePromptParts(prompt),
        })
        check()
        // A requested schema without structured output (or a child session with StructuredOutputError) fails
        // explicitly. The catch below sets entry.status="failed" and entry.error and rethrows, so
        // pipeline/parallel/fanout record null while /workflow and the completion notice show the reason.
        const resolved = resolveAgentOutput({
          schemaRequested: !!opts.schema,
          role: result.info.role,
          structured: result.info.role === "assistant" ? result.info.structured : undefined,
          text: messageFrom(result),
          error: result.info.role === "assistant" ? result.info.error : undefined,
        })
        if (!resolved.ok) throw new Error(resolved.error)
        const output = resolved.output
        await flushUpdate()
        entry.status = "completed"
        entry.completedAt = Date.now()
        if (opts.workUnitId) {
          const unit = workUnitsById.get(opts.workUnitId)
          if (unit) unit.status = "completed"
        }
        const saved: WorkflowRunCacheEntry = {
          hash: callHash,
          result: output,
          agent: clone(entry),
        }
        cache.entries.push(saved)
        await WorkflowState.write(input.sessionID, cache)
        await update()
        return output
      } catch (error) {
        await flushUpdate()
        entry.status = "failed"
        entry.completedAt = Date.now()
        entry.error = error instanceof Error ? error.message : String(error)
        if (opts.workUnitId) {
          const unit = workUnitsById.get(opts.workUnitId)
          if (unit) unit.status = "failed"
        }
        await update()
        throw error
      } finally {
        release()
      }
    }

    const parallel = async (items: Array<() => Promise<unknown> | unknown>) => {
      if (!Array.isArray(items)) throw new Error("parallel() expects an array of functions")
      return Promise.all(
        items.map(async (item) => {
          try {
            if (typeof item !== "function") throw new Error("parallel() items must be functions")
            return await item()
          } catch {
            return null
          }
        }),
      )
    }

    const fanout = async (
      units: unknown[],
      mapper?: (unit: unknown, index: number) => Omit<WorkflowAgentOptions, "workUnitId"> & { prompt?: string },
    ) => {
      if (!Array.isArray(units)) throw new Error("fanout() expects an array of work units")
      if (units.length === 0) return []
      if (agentCount + units.length > MAX_TOTAL_WORKFLOW_AGENTS) {
        throw new Error(`Workflow exceeded ${MAX_TOTAL_WORKFLOW_AGENTS} agent calls`)
      }
      const seenIds = new Set<string>()
      const uniqueId = (id: string) => {
        let next = id
        let index = 2
        while (workUnitsById.has(next) || seenIds.has(next)) {
          next = `${id}-${index++}`
        }
        seenIds.add(next)
        return next
      }
      const planned = units.map((unit, index) => {
        const item = typeof unit === "object" && unit ? (unit as Record<string, unknown>) : {}
        const title = text(item.title, `Work unit ${index + 1}`)
        const description = text(item.description ?? item.prompt, "")
        const id = uniqueId(text(item.id, `unit-${workUnits.length + index + 1}`))
        const phaseTitle = text(item.phase, phase ?? "")
        const files = Array.isArray(item.files)
          ? item.files.filter((file): file is string => typeof file === "string")
          : undefined
        const mapped = mapper ? mapper(unit, index) : undefined
        const prompt = mapped?.prompt ?? text(item.prompt, description || title)
        const { prompt: _prompt, ...opts } = mapped ?? {}
        return {
          id,
          title,
          description,
          prompt,
          phase: phaseTitle || undefined,
          files,
          opts,
        }
      })
      for (const item of planned) {
        const workUnit: WorkflowWorkUnit = {
          id: item.id,
          title: item.title,
          ...(item.description ? { description: item.description } : {}),
          phase: item.opts.phase ?? item.phase ?? phase,
          ...(item.files?.length ? { files: item.files } : {}),
          agentLabel: item.opts.label ?? item.title,
          agentType: item.opts.agent ?? item.opts.agentType ?? "workflow-subagent",
          status: "queued",
        }
        workUnits.push(workUnit)
        workUnitsById.set(workUnit.id, workUnit)
      }
      if (!maxConcurrentAgents) dynamicConcurrentAgents = Math.max(dynamicConcurrentAgents ?? 0, planned.length)
      await update()
      return parallel(
        planned.map((item) => () => {
          return agent(item.prompt, {
            ...item.opts,
            label: item.opts.label ?? item.title,
            phase: item.opts.phase ?? item.phase ?? phase,
            workUnitId: item.id,
          })
        }),
      )
    }

    const pipeline = async (
      items: unknown[],
      ...steps: Array<(prev: unknown, original: unknown, index: number) => Promise<unknown> | unknown>
    ) => {
      if (!Array.isArray(items)) throw new Error("pipeline() expects an array as the first argument")
      if (steps.length === 0) throw new Error("pipeline() expects one or more step functions")
      return Promise.all(
        items.map(async (original, index) => {
          let current = original
          for (const step of steps) {
            try {
              current = await step(current, original, index)
            } catch {
              return null
            }
          }
          return current
        }),
      )
    }

    const setPhase = async (title: string) => {
      phase = title
      await update()
    }

    const log = async (message: unknown) => {
      logs.push({ id: ulid(), level: "log", message: stringify(message), phase, at: Date.now() })
      await update()
    }

    const narrate = async (message: unknown) => {
      logs.push({ id: ulid(), level: "narrate", message: stringify(message), phase, at: Date.now() })
      await update()
    }

    const nested = async (name: string, args: unknown) => {
      const workflow = await WorkflowRegistry.get(name)
      if (!workflow) throw new Error(`Unknown workflow: ${name}`)
      if (!input.hooks.runNested) throw new Error("Nested workflow execution is unavailable")
      return input.hooks.runNested(workflow.name, args)
    }

    const sandbox = Object.assign(Object.create(null), {
      args: clone(input.args),
      agent,
      parallel,
      fanout,
      pipeline,
      phase: setPhase,
      workflow: nested,
      log,
      narrate,
      budget: Object.freeze({ maxAgents: MAX_TOTAL_WORKFLOW_AGENTS, maxConcurrentAgents }),
      URL,
      console: Object.freeze({ log }),
    })
    const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
    const script = new Script(`${STRING_RESULT_COMPAT_PRELUDE}\n(async () => {\n${input.script.body}\n})()`, {
      filename: input.script.scriptPath ?? `workflow:${input.script.name}`,
    })
    try {
      // Check abort before running: a cancel before the script starts must end as aborted, not run to completion
      check()
      const result = await script.runInContext(context, { timeout: 1000 })

      await update("completed", { result, resumable: true })
      await WorkflowState.write(input.sessionID, cache)
      return { result, metadata: metadata("completed", { result }) }
    } catch (error) {
      const aborted = signal.aborted
      const message = error instanceof Error ? error.message : String(error)
      // Explain missing sandbox globals (require, process, ...) on failure; keep the original message on abort
      await update(aborted ? "aborted" : "failed", {
        error: aborted ? message : explainWorkflowError(message),
        resumable: true,
      })
      await WorkflowState.write(input.sessionID, cache)
      throw error
    }
  }
}
