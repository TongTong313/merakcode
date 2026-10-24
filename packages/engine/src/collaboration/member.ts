import {
  connect,
  ConnectionClosed,
  PROTOCOL,
  type Answer,
  type Info,
  type Permission,
  type Product,
  type Question,
  type Result,
  type Step,
  type Task,
  type Verdict,
} from "@merakcode/sdk/adapter"
import { Log } from "@merakcode/log/logger"
import { Process } from "@merakcode/util/process"
import path from "node:path"
import { CommandAnalysis } from "../permission/command"
import { PermissionNext } from "../permission/next"
import { PermissionPolicy } from "../permission/policy"
import { Shell } from "../shell/shell"
import type { Tool } from "../tool/tool"

const log = Log.create({ service: "collaboration.member" })

/** What a member's adapter can ask of MerakCode while it works */
type MemberHost = {
  step(step: Step): void
  permission(request: Permission): Promise<Verdict>
  question(questions: Question[]): Promise<Answer[]>
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
  const { child, rpc, ended } = open({
    launch: input.launch,
    product: input.product,
    cwd: input.task.cwd,
    handlers: {
      step: (step: Step) => input.host.step(step),
      "permission/request": (params: { request: Permission }) => input.host.permission(params.request),
      "question/ask": async (params: { questions: Question[] }) => ({
        answers: await input.host.question(params.questions),
      }),
    },
  })
  // Stopping tells the adapter first, so it can stop its CLI cleanly; one that is still there after the grace period
  // is ended with everything it started
  const cancel = () => {
    rpc.notify("task/cancel")
    setTimeout(() => void close(child), CANCEL_GRACE).unref()
  }
  if (input.abort.aborted) cancel()
  input.abort.addEventListener("abort", cancel, { once: true })
  const stopped = new Promise<never>((_, reject) =>
    input.abort.addEventListener("abort", () => reject(new Error("The member was stopped")), { once: true }),
  )
  stopped.catch(() => {})
  try {
    const info = await Promise.race([
      rpc.request<Info>("initialize", { protocol: PROTOCOL, product: input.product }).catch(ended),
      stopped,
    ])
    if (info.unavailable) throw new Error(info.unavailable)
    return await Promise.race([rpc.request<Result>("task/run", input.task).catch(ended), stopped])
  } finally {
    input.abort.removeEventListener("abort", cancel)
    child.stdin?.end()
    // Done or failed on its own: nothing is left for the adapter to do, so it stops its CLI and exits once its stdin is
    // closed. A stopped one has its grace period. Waiting matters: on Windows a CLI started through a shim outlives an
    // adapter that is gone before it stopped it.
    if (!input.abort.aborted) await close(child)
  }
}

/** How long a stopped adapter may take to stop its CLI before it is ended */
const CANCEL_GRACE = 5_000
/** How long a finished adapter may take to exit on its own */
const CLOSE_GRACE = 3_000
/** How long an adapter may take to say what its CLI is */
const INSPECT_TIMEOUT = 10_000

/** What an adapter reports about its CLI: only the handshake, no task */
export async function inspectMember(input: { launch: string[]; product: Product; cwd: string }): Promise<Info> {
  const { child, rpc, ended } = open({ ...input, handlers: {} })
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`The adapter did not answer within ${INSPECT_TIMEOUT / 1000}s`)),
      INSPECT_TIMEOUT,
    ).unref(),
  )
  try {
    return await Promise.race([
      rpc.request<Info>("initialize", { protocol: PROTOCOL, product: input.product }).catch(ended),
      timeout,
    ])
  } finally {
    await close(child)
  }
}

/**
 * Starts an adapter and connects to it. stderr goes to the log; ended turns a request cut off by the adapter exiting
 * into an error that says so, with the last thing it wrote to stderr (such as a missing module).
 */
function open(input: {
  launch: string[]
  product: Product
  cwd: string
  handlers: Parameters<typeof connect>[0]["handlers"]
}) {
  // Detached, so an adapter outlives an engine that exits mid-task long enough to stop its CLI: it sees its stdin close.
  // Its library makes sure it does not live on after that.
  const child = Process.spawn(input.launch, {
    cwd: input.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
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
    log.info("adapter stderr", { product: input.product.id, line })
  })
  const rpc = connect({
    lines: lines(child.stdout),
    send: (line) => child.stdin?.write(line + "\n"),
    handlers: input.handlers,
    noise: (line) => log.info("adapter output", { product: input.product.id, line }),
  })
  const ended = async (error: Error): Promise<never> => {
    if (!(error instanceof ConnectionClosed)) throw error
    const code = await child.exited.catch(() => -1)
    await stderr
    const said = complaint || last
    throw new Error(`The adapter ended before it answered (exit code ${code})${said ? `: ${said}` : ""}`)
  }
  return { child, rpc, ended }
}

/**
 * Ends an adapter that has nothing left to do and waits until it is gone, with what it started. Its stdin is closed,
 * so it stops its CLI and exits; one still there after a moment is ended.
 */
async function close(child: Process.Child) {
  child.stdin?.end()
  const exited = child.exited.then(() => true).catch(() => true)
  const late = new Promise<false>((resolve) => setTimeout(() => resolve(false), CLOSE_GRACE).unref())
  if (await Promise.race([exited, late])) return
  await Shell.killTree(child, { exited: () => child.exitCode !== null })
  await exited
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

/**
 * MerakCode's answer to a member's request, by the same rules as its own tools: ask passes when the mode or a rule
 * allows it or the user approves, and throws when it is refused.
 *
 * The rules of a tool call are fixed when it starts, and a member makes many requests in one delegate call: a grant
 * the user gave since ("allow for this conversation") is read from the group session, so the member is not asked again.
 */
export async function decide(
  ctx: Pick<Tool.Context, "ask" | "sessionID">,
  request: Permission,
  cwd: string,
): Promise<Verdict> {
  const input = await checksOf(request, cwd)
  const grants = await PermissionNext.grants(ctx.sessionID)
  const covered = input.checks.every(
    (check) => PermissionNext.evaluate(check.permission, check.pattern, grants).action === "allow",
  )
  if (covered) return { allow: true }
  try {
    await ctx.ask(input)
    return { allow: true }
  } catch (error) {
    const refused =
      error instanceof PermissionNext.RejectedError ||
      error instanceof PermissionNext.CorrectedError ||
      error instanceof PermissionNext.DeniedError
    if (refused) return { allow: false, message: error.message }
    throw error
  }
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
