/**
 * Member adapters: small programs that let a collaboration group in MerakCode give tasks to a coding CLI.
 *
 * MerakCode starts the adapter and talks to it on stdin and stdout, one JSON-RPC 2.0 message per line (the member
 * protocol). The adapter drives its CLI however that CLI works, and hands every step, permission request and question
 * to MerakCode, which applies the user's permission mode and asks the user when needed. One process does one task.
 *
 * Needs only Node, so it also ships as a single file that an adapter can sit next to.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import readline from "node:readline"
import crossSpawn from "cross-spawn"
import z from "zod"

/**
 * Starts a CLI: node:child_process spawn with the same arguments and result, which also starts a CLI installed by npm
 * on Windows (a .cmd shim, which spawn cannot start), passing its arguments unchanged
 */
export const spawn = crossSpawn as typeof nodeSpawn

/** How long a CLI may take to exit on its own once its input is closed */
const STOP_GRACE = 3_000

/**
 * Ends a CLI and everything it started (on Windows the CLI behind an npm shim is the shim's own child), and resolves
 * once that is done. A CLI whose input is still open is asked first by closing it, and gets a moment to exit.
 */
export async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const exited = new Promise<true>((resolve) => child.once("exit", () => resolve(true)))
  if (child.stdin && !child.stdin.writableEnded) {
    child.stdin.end()
    const late = new Promise<false>((resolve) => setTimeout(() => resolve(false), STOP_GRACE).unref())
    if (await Promise.race([exited, late])) return
  }
  if (process.platform === "win32") {
    const kill = nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    await new Promise((resolve) => {
      kill.once("exit", resolve)
      kill.once("error", resolve)
    })
    return
  }
  // Elsewhere a signal reaches one process: the ones the CLI started are found by their parent first
  for (const pid of [child.pid, ...(await descendants(child.pid))])
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // Gone already
    }
  const late = new Promise<false>((resolve) => setTimeout(() => resolve(false), STOP_GRACE).unref())
  await Promise.race([exited, late])
}

/** The processes a process started, and the ones they started, as ps lists them */
async function descendants(pid: number) {
  const listing = await new Promise<string>((resolve) => {
    const ps = nodeSpawn("ps", ["-A", "-o", "pid=", "-o", "ppid="], { stdio: ["ignore", "pipe", "ignore"] })
    let text = ""
    ps.stdout.on("data", (chunk) => (text += chunk))
    ps.once("close", () => resolve(text))
    ps.once("error", () => resolve(""))
  })
  const children = new Map<number, number[]>()
  for (const line of listing.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (child && parent) children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const found: number[] = []
  const visit = (parent: number) => {
    for (const child of children.get(parent) ?? []) {
      found.push(child)
      visit(child)
    }
  }
  visit(pid)
  return found
}

/** How long a CLI may take to print its version */
const VERSION_TIMEOUT = 5_000

/**
 * The first line a CLI prints for --version, or why it gives none: not installed, failing, or not answering in time
 * (it is stopped then). For inspect, which must not start any work.
 */
export async function version(command: string): Promise<{ version?: string; unavailable?: string }> {
  const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  const ended = new Promise<number | "missing">((resolve) => {
    child.once("error", () => resolve("missing"))
    child.once("close", (code) => resolve(code ?? -1))
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), VERSION_TIMEOUT)))
  const code = await Promise.race([ended, late])
  clearTimeout(timer)
  if (code === "missing") return { unavailable: `${command} is not installed` }
  if (code === "late") {
    await stop(child)
    return { unavailable: `${command} --version did not answer within ${VERSION_TIMEOUT / 1000}s` }
  }
  const first = (text: string) => text.trim().split(/\r?\n/)[0]
  if (code !== 0) return { unavailable: first(stderr || stdout) || `exit code ${code}` }
  return { version: first(stdout) }
}

/** Version of the member protocol */
export const PROTOCOL = 3

/** How long an adapter may take to stop its CLI once MerakCode is gone */
const GONE_GRACE = 5_000

/** The user's permission mode in the group */
export type PermissionLevel = "ask" | "autoApprove" | "fullTakeover"
const level = z.enum(["ask", "autoApprove", "fullTakeover"])

export type ProductModel = { id: string; providerID?: string }
export type ModelList = { models: (ProductModel & { title: string })[]; allowCustomID: boolean }
export type Capabilities = {
  modelSelection: boolean
  modelDiscovery: boolean
  textStreaming: boolean
  resume: boolean
  permission: "merak" | "external"
  questions: boolean
  draftOnly?: boolean
  plan?: { fullInput: boolean; contextTokens: number; reservedTokens: number; fixedInputTokens: number }
  /** Only reported operations are governed; unreported native actions remain outside host control. */
  control?: {
    reportedOperations: string[]
    cancellation: "operation" | "task" | "none"
    liveMode: boolean
    isolation?: "product" | "none" | "unknown"
    limitations: string[]
  }
}

/** Whether the adapter declares a pre-action callback for every operation category. */
export function supportsPerOperationControl(capabilities?: Capabilities) {
  return (
    capabilities?.permission === "merak" &&
    ["read", "write", "command", "network", "tool"].every((kind) =>
      capabilities.control?.reportedOperations.includes(kind),
    )
  )
}

/**
 * The product as configured in MerakCode. command and args are the CLI and extra arguments the user set; an adapter
 * written for one CLI may ignore them. resumeArgs and sessionLine are a one-shot product's settings.
 */
export type Product = {
  id: string
  title: string
  command?: string
  args?: string[]
  resumeArgs?: string[]
  sessionLine?: string
}

/** What the adapter reports about its CLI, without running a task */
export type Info = {
  name: string
  capabilities?: Capabilities
  /** Version of the CLI, shown in settings */
  version?: string
  /** Where the CLI is on this machine */
  path?: string
  /** Lowest version known to work well; an older one is shown with a hint to upgrade */
  recommended?: string
  /** Command that upgrades the CLI */
  upgrade?: string
  /** Why the CLI cannot take a task now, such as not being installed */
  unavailable?: string
}

export type Task = {
  /** The member's prompt: its duty, the group's state and the task */
  prompt: string
  /** The project directory to work in */
  cwd: string
  permissionLevel: PermissionLevel
  /** Draft-only scope does not authorize project mutations. */
  scope?: "draft"
  plan?: { content: string; revision: number; executionID?: string }
  /** The member's private session from its last task, to continue */
  resume?: string
  model?: ProductModel
}

/** Something the member did, shown live in its chat bubble */
export type Step = { tool: string; detail?: string }

/** An operation the CLI wants to do; MerakCode decides it with the same rules as its own tools */
export type Permission =
  | { kind: "write"; paths: string[] }
  | { kind: "command"; command: string }
  | { kind: "network"; host: string; url?: string }
  | { kind: "read"; paths: string[] }
  | { kind: "tool"; name: string; detail?: string }

/** MerakCode's answer; a refusal says why, for the CLI to work around */
export type Verdict = { allow: true } | { allow: false; message: string }
export type OperationStart = { id: string; request: Permission; isolation: "product" | "none" | "unknown" }
export type OperationFinish = { id: string; status: "completed" | "failed" | "stopped" }
export type OperationAdmission = { allow: true; signal: AbortSignal } | { allow: false; message: string }
export type PlanSubmission = { id: string; content: string; expectedRevision: number }
export type PlanReceipt = { revision: number }
const planSubmissionSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  expectedRevision: z.number().int().nonnegative(),
})
const operationStartSchema = z.object({
  id: z.string().min(1),
  isolation: z.enum(["product", "none", "unknown"]),
  request: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("read"), paths: z.array(z.string()).min(1) }),
    z.object({ kind: z.literal("write"), paths: z.array(z.string()).min(1) }),
    z.object({ kind: z.literal("command"), command: z.string().min(1) }),
    z.object({ kind: z.literal("network"), host: z.string().min(1), url: z.string().optional() }),
    z.object({ kind: z.literal("tool"), name: z.string().min(1), detail: z.string().optional() }),
  ]),
})
const operationFinishSchema = z.object({ id: z.string().min(1), status: z.enum(["completed", "failed", "stopped"]) })
export function parseOperationStart(input: unknown): OperationStart {
  return operationStartSchema.parse(input)
}
export function parseOperationFinish(input: unknown): OperationFinish {
  return operationFinishSchema.parse(input)
}

export type Question = {
  question: string
  /** Very short label */
  header: string
  options: { label: string; description: string }[]
  multiple?: boolean
  /** Whether the user may type an answer of their own (default true) */
  custom?: boolean
}

/** The labels the user picked or typed, one list per question */
export type Answer = string[]

export type Result = {
  text: string
  /** The CLI's session, given back as resume with the member's next task */
  sessionId?: string
  actualModel?: ProductModel
  final?: { messageID: string; parts: { partID: string; text: string }[] }
}

export type TextDelta = { messageID: string; partID: string; delta: string }

/** How an adapter reaches MerakCode while it works */
export type Host = {
  sessionStarted(input: { sessionId: string }): Promise<void>
  textDelta(input: TextDelta): void
  step(step: Step): void
  permission(request: Permission): Promise<Verdict>
  operationStart(input: OperationStart): Promise<OperationAdmission>
  operationFinish(input: OperationFinish): Promise<void>
  question(questions: Question[]): Promise<Answer[]>
  submitPlan(input: PlanSubmission): Promise<PlanReceipt>
}

export type Definition = {
  /** Confirm true only after the named native operation has actually stopped. */
  cancelOperation?(id: string): { stopped: boolean } | Promise<{ stopped: boolean }>
  /** Optional native policy update. The task object also receives the current mode in place. */
  permissionLevelChanged?(mode: PermissionLevel): void | Promise<void>
  inspect(product: Product): Info | Promise<Info>
  models?(product: Product, signal: AbortSignal): ModelList | Promise<ModelList>
  /** Does the task; signal aborts when the user stops the group */
  run(task: Task & { product: Product; signal: AbortSignal }, host: Host): Promise<Result>
}

/** A request still waiting when the other side went away */
export class ConnectionClosed extends Error {
  constructor() {
    super("The connection closed")
  }
}

type Message = {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * One end of a JSON-RPC 2.0 connection over lines. handlers answer the other side's requests and notifications; a
 * line that is not JSON goes to noise. closed resolves when the lines end, failing what is still waiting for a reply.
 */
export function connect(options: {
  lines: AsyncIterable<string>
  send: (line: string) => void
  handlers: Record<string, (params: any) => unknown>
  noise?: (line: string) => void
}) {
  let next = 1
  const waiting = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const write = (message: Message) => options.send(JSON.stringify({ jsonrpc: "2.0", ...message }))
  const answer = async (message: Message & { method: string }) => {
    const handler = options.handlers[message.method]
    if (!handler) {
      if (message.id !== undefined)
        write({ id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } })
      return
    }
    try {
      const result = await handler(message.params)
      if (message.id !== undefined) write({ id: message.id, result: result ?? null })
    } catch (error) {
      if (message.id !== undefined)
        write({
          id: message.id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        })
    }
  }
  const closed = (async () => {
    for await (const line of options.lines) {
      if (!line.trim()) continue
      const message = parse(line)
      if (!message) {
        options.noise?.(line)
        continue
      }
      if (typeof message.method === "string") {
        void answer(message as Message & { method: string })
        continue
      }
      const call = message.id === undefined ? undefined : waiting.get(message.id)
      if (!call) continue
      waiting.delete(message.id!)
      if (message.error) call.reject(new Error(message.error.message))
      else call.resolve(message.result)
    }
    for (const call of waiting.values()) call.reject(new ConnectionClosed())
    waiting.clear()
  })()
  return {
    request<T>(method: string, params?: unknown) {
      const id = next++
      return new Promise<T>((resolve, reject) => {
        waiting.set(id, { resolve: resolve as (value: unknown) => void, reject })
        write({ id, method, params })
      })
    },
    notify(method: string, params?: unknown) {
      write({ method, params })
    },
    closed,
  }
}

function parse(line: string): Message | undefined {
  try {
    const value = JSON.parse(line)
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Runs an adapter on this process's stdin and stdout. console.log goes to stderr, which MerakCode keeps in its log,
 * so stray output cannot break the protocol.
 */
export function adapter(definition: Definition) {
  console.log = console.info = (...items: unknown[]) => console.error(...items)
  const stop = new AbortController()
  let product: Product = { id: "", title: "" }
  let currentTask: Task | undefined
  let currentPermissionLevel: PermissionLevel | undefined
  let permissionRevision = -1
  let initialized = false
  const operations = new Map<string, { controller: AbortController; admitted: boolean }>()
  const productSchema = z.object({
    id: z.string(),
    title: z.string(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    resumeArgs: z.array(z.string()).optional(),
    sessionLine: z.string().optional(),
  })
  const taskSchema = z.object({
    prompt: z.string(),
    cwd: z.string(),
    permissionLevel: level,
    scope: z.literal("draft").optional(),
    plan: z
      .object({ content: z.string(), revision: z.number().int().nonnegative(), executionID: z.string().optional() })
      .optional(),
    resume: z.string().optional(),
    model: z.object({ id: z.string(), providerID: z.string().optional() }).optional(),
  })
  const requireInitialized = () => {
    if (!initialized) throw new Error("A successful protocol handshake is required before task messages.")
  }
  const rpc = connect({
    lines: readline.createInterface({ input: process.stdin, crlfDelay: Infinity }),
    send: (line) => process.stdout.write(line + "\n"),
    handlers: {
      initialize: async (value: unknown) => {
        initialized = false
        const params = z.object({ protocol: z.literal(PROTOCOL), product: productSchema }).safeParse(value)
        if (!params.success)
          throw new Error(
            "Unsupported adapter protocol or initialization parameters. Upgrade the host before running a task.",
          )
        product = params.data.product
        const info = await definition.inspect(product)
        initialized = true
        return { ...info, protocol: PROTOCOL }
      },
      "model/list": () => {
        requireInitialized()
        if (!definition.models) throw new Error("This adapter does not support model discovery")
        return definition.models(product, stop.signal)
      },
      "task/run": (value: unknown) => {
        requireInitialized()
        const task = taskSchema.parse(value)
        const active = {
          ...task,
          permissionLevel: currentPermissionLevel ?? task.permissionLevel,
          product,
          signal: stop.signal,
        }
        currentTask = active
        return definition.run(active, host)
      },
      "task/permission-level": async (value: unknown) => {
        requireInitialized()
        const input = z.object({ permissionLevel: level, revision: z.number().int().nonnegative() }).parse(value)
        if (input.revision <= permissionRevision) return
        permissionRevision = input.revision
        currentPermissionLevel = input.permissionLevel
        if (currentTask) currentTask.permissionLevel = input.permissionLevel
        await definition.permissionLevelChanged?.(input.permissionLevel)
      },
      "operation/cancel": async (value: unknown) => {
        requireInitialized()
        const { id } = z.object({ id: z.string().min(1) }).parse(value)
        const operation = operations.get(id)
        if (!operation) return { stopped: true }
        operation.controller.abort()
        if (!operation.admitted) return { stopped: true }
        return definition.cancelOperation
          ? z.object({ stopped: z.boolean() }).parse(await definition.cancelOperation(id))
          : { stopped: false }
      },
      "task/cancel": () => {
        stop.abort()
        for (const operation of operations.values()) operation.controller.abort()
      },
    },
  })
  const host: Host = {
    sessionStarted: (input) => rpc.request<void>("session.started", input),
    textDelta: (input) => rpc.notify("text.delta", input),
    step: (step) => rpc.notify("step", step),
    permission: (request) => rpc.request<Verdict>("permission/request", { request }),
    operationStart: async (input) => {
      input = parseOperationStart(input)
      stop.signal.throwIfAborted()
      if (operations.has(input.id)) throw new Error("The operation id is already active")
      const operation = { controller: new AbortController(), admitted: false }
      operations.set(input.id, operation)
      try {
        const verdict = await rpc.request<Verdict>("operation/start", input)
        if (!verdict.allow) {
          operations.delete(input.id)
          return verdict
        }
        if (operation.controller.signal.aborted) {
          operations.delete(input.id)
          return { allow: false, message: "The operation was cancelled before launch" }
        }
        operation.admitted = true
        return { allow: true, signal: operation.controller.signal }
      } catch (error) {
        operations.delete(input.id)
        throw error
      }
    },
    operationFinish: async (input) => {
      input = parseOperationFinish(input)
      await rpc.request<void>("operation/finish", input)
      operations.delete(input.id)
    },
    question: async (questions) => (await rpc.request<{ answers: Answer[] }>("question/ask", { questions })).answers,
    submitPlan: (input) => rpc.request<PlanReceipt>("plan/submit", planSubmissionSchema.parse(input)),
  }
  // MerakCode closes stdin when it is done with the adapter, or when it goes away: the task stops. A request still
  // waiting then fails with ConnectionClosed; left unhandled it must not end the adapter before it stopped its CLI.
  void rpc.closed.then(() => {
    stop.abort()
    // An adapter whose CLI will not stop must not live on without MerakCode
    setTimeout(() => process.exit(0), GONE_GRACE).unref()
  })
  process.on("unhandledRejection", (error) => {
    if (error instanceof ConnectionClosed) return
    throw error
  })
}

/**
 * Tries an adapter the way MerakCode runs it, for whoever writes one. check only does the handshake and prints what
 * the adapter reports; test also gives it one task in the current directory, allows every request, picks the first
 * option of every question, and prints each step, request, question and the result. Run it in an empty directory.
 */
async function tryAdapter(input: {
  launch: string[]
  prompt?: string
  permissionLevel?: PermissionLevel
  print?: (line: string) => void
}) {
  const print = input.print ?? ((line: string) => console.log(line))
  const { spawn } = await import("node:child_process")
  const [command, ...args] = input.launch
  if (!command) throw new Error("No adapter command")
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] })
  const rpc = connect({
    lines: readline.createInterface({ input: child.stdout!, crlfDelay: Infinity }),
    send: (line) => child.stdin!.write(line + "\n"),
    handlers: {
      step: (step: Step) => print(`step ${step.tool}${step.detail ? " " + step.detail : ""}`),
      "session.started": (input: { sessionId: string }) => print(`session ${input.sessionId}`),
      "text.delta": (input: TextDelta) => print(`text ${input.delta}`),
      "permission/request": (params: { request: Permission }) => {
        print(`permission ${JSON.stringify(params.request)}`)
        return { allow: true }
      },
      "operation/start": (value: unknown) => {
        const operation = parseOperationStart(value)
        print(`operation/start ${operation.id} ${operation.isolation} ${JSON.stringify(operation.request)}`)
        return { allow: true }
      },
      "operation/finish": (value: unknown) => {
        const operation = parseOperationFinish(value)
        print(`operation/finish ${operation.id} ${operation.status}`)
      },
      "question/ask": (params: { questions: Question[] }) => {
        for (const question of params.questions) print(`question ${question.question}`)
        return { answers: params.questions.map((question) => (question.options[0] ? [question.options[0].label] : [])) }
      },
    },
    noise: (line) => print(`not protocol: ${line}`),
  })
  try {
    const info = await rpc.request<Info & { protocol: number }>("initialize", {
      protocol: PROTOCOL,
      product: { id: "test", title: "test" },
    })
    if (info.protocol !== PROTOCOL)
      throw new Error("Unsupported adapter protocol. Upgrade the adapter before running a task.")
    print(`adapter ${info.name}${info.version ? " " + info.version : ""}${info.path ? " at " + info.path : ""}`)
    if (info.unavailable) print(`unavailable: ${info.unavailable}`)
    if (input.prompt === undefined || info.unavailable) return info
    const permissionLevel = input.permissionLevel ?? "ask"
    const result = await rpc.request<Result>("task/run", {
      prompt: input.prompt,
      cwd: process.cwd(),
      permissionLevel,
    })
    print(`result ${result.text}`)
    if (result.sessionId) print(`session ${result.sessionId}`)
    return result
  } finally {
    child.stdin!.end()
  }
}

/** node merakcode-adapter.mjs check|test [--permission-level <level>] -- <adapter command> ["<task>"] */
export async function cli(argv: string[]) {
  const mode = argv[0]
  const explicit = argv[1] === "--permission-level"
  const permissionLevel = explicit ? argv[2] : "ask"
  const separator = explicit ? 3 : 1
  const rest = argv.slice(separator + 1)
  if (
    (mode !== "check" && mode !== "test") ||
    argv[separator] !== "--" ||
    rest.length === 0 ||
    !level.safeParse(permissionLevel).success
  ) {
    console.error(
      'Usage: node merakcode-adapter.mjs check -- <adapter command>\n       node merakcode-adapter.mjs test [--permission-level ask|autoApprove|fullTakeover] -- <adapter command> "<task>"',
    )
    process.exitCode = 2
    return
  }
  const launch = mode === "test" ? rest.slice(0, -1) : rest
  const prompt = mode === "test" ? rest.at(-1) : undefined
  await tryAdapter({ launch, prompt, permissionLevel: level.parse(permissionLevel) }).catch((error: Error) => {
    console.error(`failed: ${error.message}`)
    process.exitCode = 1
  })
}
