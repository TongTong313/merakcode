import {
  connect,
  ConnectionClosed,
  PROTOCOL,
  type Answer,
  type Info,
  type ModelList,
  type Permission,
  type Product,
  type Question,
  type Result,
  type Step,
  type Task,
  type TextDelta,
  type Verdict,
} from "@merakcode/sdk/adapter"
import { Log } from "@merakcode/log/logger"
import { Process } from "@merakcode/util/process"
import path from "node:path"
import { CommandAnalysis } from "../permission/command"
import { PermissionNext } from "../permission/next"
import { PermissionPolicy } from "../permission/policy"
import { Shell } from "../../infra/process/shell/shell"
import { z } from "zod"
import { Config } from "@merakcode/engine/agent/settings/index"
import { Question as SessionQuestion } from "../session/question"
import { AsyncLocalStorage } from "node:async_hooks"
import { Instance } from "../../infra/project/instance"
import { Text } from "../prompt/text"
import { containAdapter } from "./process-tree"
import { randomUUID } from "node:crypto"

const log = Log.create({ service: "agent.connection" })
const Model = z.object({ id: z.string().min(1), providerID: z.string().min(1).optional() })
const Capabilities = z.object({
  modelSelection: z.boolean(),
  modelDiscovery: z.boolean(),
  textStreaming: z.boolean(),
  resume: z.boolean(),
  permission: z.enum(["merak", "external"]),
  questions: z.boolean(),
})
const InfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  path: z.string().optional(),
  recommended: z.string().optional(),
  upgrade: z.string().optional(),
  unavailable: z.string().optional(),
  capabilities: Capabilities.optional(),
})
const ResultSchema = z.object({
  text: z.string(),
  sessionId: z.string().min(1).optional(),
  actualModel: Model.optional(),
  final: z
    .object({
      messageID: z.string().min(1),
      parts: z.array(z.object({ partID: z.string().min(1), text: z.string() })),
    })
    .refine((final) => final.parts.some((part) => part.text.trim().length > 0))
    .optional(),
})

/** What a member's adapter can ask of MerakCode while it works */
type MemberHost = {
  sessionStarted?(input: { sessionId: string }): Promise<void>
  textDelta?(input: TextDelta): void | Promise<void>
  step(step: Step): void | Promise<void>
  permission(request: Permission): Promise<Verdict>
  question(questions: Question[]): Promise<Answer[]>
}

type RunInput = Parameters<typeof runMember>[0]
type RegisteredRun = {
  productID: string
  sessionID: string
  controller: AbortController
  done: Promise<void>
  cancelPending: () => Promise<void>
}
const running = new Map<string, RegisteredRun>()

export async function runExternal(
  input: RunInput & { runID: string; sessionID: string; seatID?: string },
): Promise<Result> {
  input.abort.throwIfAborted()
  const controller = new AbortController()
  const finished = Promise.withResolvers<void>()
  const restore = AsyncLocalStorage.snapshot()
  const cancelPending = () =>
    restore(async () => {
      if (!Instance.has()) return
      await Promise.all([PermissionNext.abortExecution(input.runID), SessionQuestion.abortExecution(input.runID)])
    })
  const cancelled = () => {
    controller.abort(input.abort.reason)
    void cancelPending().catch((error) => log.error("failed to cancel external requests", { error }))
  }
  input.abort.addEventListener("abort", cancelled, { once: true })
  running.set(input.runID, {
    productID: input.product.id,
    sessionID: input.sessionID,
    controller,
    done: finished.promise,
    cancelPending,
  })
  if (input.abort.aborted) cancelled()
  try {
    return await runMember({ ...input, abort: controller.signal })
  } finally {
    input.abort.removeEventListener("abort", cancelled)
    try {
      await cancelPending()
    } finally {
      running.delete(input.runID)
      finished.resolve()
    }
  }
}

export async function stopProduct(productID: string) {
  const affected = [...running.entries()].filter(([, run]) => run.productID === productID)
  for (const [, run] of affected) {
    run.controller.abort(new Error("The product was disabled"))
    await run.cancelPending()
  }
  await Promise.all(affected.map(([, run]) => run.done))
}

export async function settleExternal(sessionID: string) {
  await Promise.all([...running.values()].filter((run) => run.sessionID === sessionID).map((run) => run.done))
}

/** Runs one task through a member adapter: one process, started for the task and ended with it */
export async function runMember(input: {
  /** Command line that starts the adapter */
  launch: string[]
  product: Product
  task: Task
  abort: AbortSignal
  host: MemberHost
}): Promise<Result> {
  input.abort.throwIfAborted()
  const stoppedMessage = await Text.pick({ zh: "外部任务已停止", en: "The external task was stopped" })
  input.abort.throwIfAborted()
  let accepting = true
  let writes = Promise.resolve()
  let writeError: unknown
  const enqueue = (write: () => void | Promise<void>) => {
    const next = writes.then(write)
    writes = next.catch((error) => {
      writeError ??= error
    })
    return next
  }
  const { child, rpc, ended, close } = await open({
    launch: input.launch,
    product: input.product,
    cwd: input.task.cwd,
    handlers: {
      "session.started": (value: unknown) => {
        const inputSession = z.object({ sessionId: z.string().min(1) }).parse(value)
        if (!accepting) return
        return enqueue(() => input.host.sessionStarted?.(inputSession))
      },
      "text.delta": (value: unknown) => {
        const delta = z
          .object({ messageID: z.string().min(1), partID: z.string().min(1), delta: z.string() })
          .safeParse(value)
        if (!delta.success) {
          void enqueue(async () => {
            throw new Error(
              await Text.pick({ zh: "适配器发送的正文事件格式无效", en: "The adapter sent an invalid text event" }),
            )
          }).catch(() => {})
          return
        }
        if (accepting) void enqueue(() => input.host.textDelta?.(delta.data)).catch(() => {})
      },
      step: (value: unknown) => {
        if (!accepting) return
        const step = z.object({ tool: z.string().min(1), detail: z.string().optional() }).safeParse(value)
        if (!step.success) {
          void enqueue(async () => {
            throw new Error(
              await Text.pick({ zh: "适配器发送的步骤事件格式无效", en: "The adapter sent an invalid step event" }),
            )
          }).catch(() => {})
          return
        }
        void enqueue(() => input.host.step(step.data)).catch(() => {})
      },
      "permission/request": (params: { request: Permission }) =>
        accepting ? input.host.permission(params.request) : { allow: false, message: "The external task has ended" },
      "question/ask": async (params: { questions: Question[] }) => {
        if (!accepting) throw new Error("The external task has ended")
        return { answers: await input.host.question(params.questions) }
      },
    },
  })
  // Stopping tells the adapter first, so it can stop its CLI cleanly; one that is still there after the grace period
  // is ended with everything it started
  const stopped = Promise.withResolvers<never>()
  stopped.promise.catch(() => {})
  const cancel = () => {
    accepting = false
    rpc.notify("task/cancel")
    stopped.reject(new Error(stoppedMessage))
  }
  input.abort.addEventListener("abort", cancel, { once: true })
  if (input.abort.aborted) cancel()
  try {
    const info = InfoSchema.parse(
      await Promise.race([
        rpc.request<Info>("initialize", { protocol: PROTOCOL, product: input.product }).catch(ended),
        stopped.promise,
      ]),
    )
    if (info.unavailable) throw new Error(info.unavailable)
    if (input.task.model && !info.capabilities?.modelSelection)
      throw new Error(
        await Text.pick({ zh: "此适配器不支持指定模型", en: "This adapter does not support selecting a model" }),
      )
    if (input.task.resume && !info.capabilities?.resume)
      throw new Error(
        await Text.pick({
          zh: "此适配器无法恢复已保存的外部线程，请新建对话",
          en: "This adapter does not support resuming the saved thread; start a new conversation",
        }),
      )
    const result = await Promise.race([rpc.request<Result>("task/run", input.task).catch(ended), stopped.promise])
    accepting = false
    await writes
    if (writeError) throw writeError
    const parsed = ResultSchema.safeParse(result)
    if (!parsed.success)
      throw new Error(await Text.pick({ zh: "适配器返回的结果格式无效", en: "The adapter returned an invalid result" }))
    return parsed.data
  } finally {
    accepting = false
    input.abort.removeEventListener("abort", cancel)
    child.stdin?.end()
    // Done or failed on its own: nothing is left for the adapter to do, so it stops its CLI and exits once its stdin is
    // closed. A stopped one has its grace period. Waiting matters: on Windows a CLI started through a shim outlives an
    // adapter that is gone before it stopped it.
    await close()
    await writes
  }
}

/** How long a finished adapter may take to exit on its own */
const CLOSE_GRACE = 3_000
/** How long an adapter may take to say what its CLI is */
const INSPECT_TIMEOUT = 10_000

/** What an adapter reports about its CLI: only the handshake, no task */
export async function inspectMember(input: { launch: string[]; product: Product; cwd: string }): Promise<Info> {
  const { rpc, ended, close } = await open({ ...input, handlers: {} })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void Text.pick(
        { zh: "适配器未在 {seconds} 秒内响应", en: "The adapter did not answer within {seconds}s" },
        { seconds: INSPECT_TIMEOUT / 1000 },
      ).then((message) => reject(new Error(message)), reject)
    }, INSPECT_TIMEOUT).unref()
  })
  try {
    return InfoSchema.parse(
      await Promise.race([
        rpc.request<Info>("initialize", { protocol: PROTOCOL, product: input.product }).catch(ended),
        timeout,
      ]),
    )
  } finally {
    clearTimeout(timer)
    await close()
  }
}

export async function discoverModels(input: { launch: string[]; product: Product; cwd: string }): Promise<ModelList> {
  const { rpc, ended, close } = await open({ ...input, handlers: {} })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void Text.pick({ zh: "读取模型列表超时", en: "Model discovery timed out" }).then(
        (message) => reject(new Error(message)),
        reject,
      )
    }, INSPECT_TIMEOUT).unref()
  })
  try {
    return await Promise.race([
      (async () => {
        const info = InfoSchema.parse(
          await rpc.request<Info>("initialize", { protocol: PROTOCOL, product: input.product }).catch(ended),
        )
        if (info.unavailable) throw new Error(info.unavailable)
        if (!info.capabilities?.modelDiscovery) return { models: [], allowCustomID: true }
        const models = await rpc.request<ModelList>("model/list").catch(ended)
        return z
          .object({ models: z.array(Model.extend({ title: z.string() })), allowCustomID: z.boolean() })
          .parse(models)
      })(),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
    await close()
  }
}

/**
 * Starts an adapter and connects to it. stderr goes to the log; ended turns a request cut off by the adapter exiting
 * into an error that says so, with the last thing it wrote to stderr (such as a missing module).
 */
async function open(input: {
  launch: string[]
  product: Product
  cwd: string
  handlers: Parameters<typeof connect>[0]["handlers"]
}) {
  // Detached, so an adapter outlives an engine that exits mid-task long enough to stop its CLI: it sees its stdin close.
  // Its library makes sure it does not live on after that.
  const marker = randomUUID()
  const child = Process.spawn(input.launch, {
    cwd: input.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    env: { ...process.env, MERAKCODE_ADAPTER_RUN: marker },
  })
  const stopTree = await containAdapter(child, marker).catch(async (error) => {
    await Shell.killTree(child)
    await child.exited.catch(() => undefined)
    throw error
  })
  // Writing to an adapter that has already exited must not take the engine down
  child.stdin?.on("error", () => {})
  // What the adapter last complained about: its last error line (Node ends a crash with its own version), else its
  // last line
  let last = ""
  let complaint = ""
  const stderr = each(child.stderr, (line) => {
    last = line.trim()
    if (/^\w*Error\b/.test(last)) complaint = last
    log.info("adapter stderr", { product: input.product.id })
  })
  const rpc = connect({
    lines: lines(child.stdout),
    send: (line) => child.stdin?.write(line + "\n"),
    handlers: input.handlers,
    noise: () => log.info("adapter output", { product: input.product.id }),
  })
  const ended = async (error: Error): Promise<never> => {
    if (!(error instanceof ConnectionClosed)) throw error
    const code = await child.exited.catch(() => -1)
    await stderr
    const said = complaint || last
    throw new Error(
      await Text.pick(
        {
          zh: "适配器在响应前退出（退出码 {code}）{detail}",
          en: "The adapter ended before it answered (exit code {code}){detail}",
        },
        { code, detail: said ? `: ${said}` : "" },
      ),
    )
  }
  return {
    child,
    rpc,
    ended,
    close: async () => {
      child.stdin?.end()
      const exited = child.exited.then(() => undefined).catch(() => undefined)
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE).unref())])
      await stopTree()
      await exited
    },
  }
}

/** The lines of a stream as they arrive */
async function* lines(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return
  const decoder = new TextDecoder()
  let text = ""
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true })
    const parts = text.split(/\r?\n/)
    text = parts.pop() ?? ""
    yield* parts
  }
  text += decoder.decode()
  if (text) yield text
}

async function each(stream: ReadableStream<Uint8Array> | null, fn: (line: string) => void) {
  for await (const line of lines(stream)) if (line.trim()) fn(line)
}

export async function decideExternal(
  context: {
    sessionID: string
    executionID: string
    cwd: string
    mode?: Task["mode"]
    tool?: { messageID: string; callID: string }
  },
  request: Permission,
): Promise<Verdict> {
  const missing = nothingToCheck(request)
  if (missing) return { allow: false, message: missing }
  const { Session } = await import("../session")
  const root = await Session.rootID(context.sessionID)
  const [session, config, grants] = await Promise.all([Session.get(root), Config.get(), PermissionNext.grants(root)])
  const current = root === context.sessionID ? session : await Session.get(context.sessionID)
  const user = PermissionNext.merge(
    PermissionNext.fromUserConfig(config.permission ?? {}),
    session.permission ?? [],
    current.permission ?? [],
  )
  const mode = session.permissionMode ?? context.mode ?? "ask"
  const rules = PermissionPolicy.ruleset(mode, user)
  const input = await checksOf(request, context.cwd)
  if (input.checks.some((check) => PermissionNext.evaluate(check.permission, check.pattern, rules).action === "deny"))
    return { allow: false, message: "The current permission policy denies this operation" }
  try {
    await PermissionNext.ask({
      ...input,
      sessionID: context.sessionID,
      root,
      executionID: context.executionID,
      tool: context.tool,
      ruleset: PermissionPolicy.ruleset(mode, PermissionNext.merge(user, grants)),
    })
    return { allow: true }
  } catch (error) {
    if (
      error instanceof PermissionNext.RejectedError ||
      error instanceof PermissionNext.CorrectedError ||
      error instanceof PermissionNext.DeniedError
    )
      return { allow: false, message: error.message }
    throw error
  }
}

/**
 * Why a request has nothing for the rules to match (no file, an empty command), if so. Such a request is refused
 * rather than let through, and the message tells the adapter what to send instead.
 */
function nothingToCheck(request: Permission) {
  const blank = (value: string | undefined) => !value?.trim()
  const instead = `Send a "tool" request with what the CLI asked for as its detail when it gives no path or command.`
  if ((request.kind === "write" || request.kind === "read") && (!request.paths.length || request.paths.some(blank)))
    return `MerakCode refused a ${request.kind} request that names no file. ${instead}`
  if (request.kind === "command" && blank(request.command))
    return `MerakCode refused a command request with an empty command. ${instead}`
  if (request.kind === "network" && blank(request.host))
    return `MerakCode refused a network request that names no host. ${instead}`
  if (request.kind === "tool" && blank(request.name)) return `MerakCode refused a tool request that names no tool.`
}

/** The checks MerakCode makes for the same operation by its own tools: edit, read, bash, webfetch, plugin tools */
async function checksOf(request: Permission, cwd: string) {
  const scope = PermissionPolicy.scope()
  const files = (op: "read" | "write", paths: string[]) =>
    paths.map((file) => PermissionPolicy.file({ op, path: path.resolve(cwd, file), ...scope }))
  if (request.kind === "write")
    return { permission: "edit", checks: files("write", request.paths), metadata: { filepath: request.paths[0] } }
  if (request.kind === "read")
    return { permission: "read", checks: files("read", request.paths), metadata: { filepath: request.paths[0] } }
  if (request.kind === "network")
    return {
      permission: "network",
      checks: [PermissionPolicy.network(request.host)],
      metadata: { url: request.url ?? request.host },
    }
  if (request.kind === "command") {
    const analysis = await CommandAnalysis.analyze(request.command, { cwd, ...scope })
    // As the bash tool: secrets are asked about even for read-only commands, outside paths when the command only reads
    const reads = analysis.paths.flatMap((file) => {
      const check = PermissionPolicy.file({ op: "read", path: file, ...scope })
      if (check.permission === "sensitive_read") return [check]
      return analysis.readOnly && check.permission === "external_read" ? [check] : []
    })
    return {
      permission: "bash",
      checks: [
        ...analysis.segments.map((segment) =>
          PermissionPolicy.command({ command: segment.text, level: segment.level, prefix: segment.prefix }),
        ),
        ...reads,
      ],
      metadata: { command: request.command, cwd, tags: analysis.tags },
    }
  }
  // A tool of the member's own, such as one of its MCP servers: judged as MerakCode judges a plugin tool
  return {
    permission: request.name,
    checks: [
      { permission: "tool", pattern: request.name, grants: [{ scope: "tool" as const, pattern: request.name }] },
    ],
    metadata: { tool: request.name, detail: request.detail },
  }
}
