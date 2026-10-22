import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { Network } from "@merakcode/util/network"
import { Http } from "@merakcode/util/http"
import { mkdir, readFile, rm, symlink } from "node:fs/promises"
import { constants } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath, pathToFileURL } from "node:url"
import { z } from "zod"
import { runtime, tmpdir } from "./fixture"
import { assertPersisted, stored } from "./sequence-persistence"
import { Filesystem } from "@merakcode/util/filesystem"
import { Glob } from "@merakcode/util/glob"
import { Process } from "@merakcode/util/process"
import { setTimeout as delay } from "node:timers/promises"

const cli = resolve(import.meta.dirname, "../..")

/**
 * The real product command run from source: `[...product("serve", ...)]`.
 * Loads sdk-sequence-network.ts first, which blocks and records every non-local fetch in the process. The model
 * server is a local fake; other outbound traffic (models.dev, LSP downloads, external skills) is turned off by the
 * MERAKCODE_DISABLE_* variables in sequence().
 */
export function product(...args: string[]): [string, ...string[]] {
  const [command, ...rest] = runtime
  return [
    command,
    ...rest,
    "--import",
    pathToFileURL(join(import.meta.dirname, "sdk-sequence-network.ts")).href,
    join(cli, "src/index.ts"),
    ...args,
  ]
}

/**
 * Starts a real backend (a long-running process such as `merak serve`). stop() uses the product's own graceful exit:
 * SIGTERM on Unix; Windows has no SIGTERM (kill is a hard kill that orphans children), so it disconnects the IPC
 * channel instead, the same way the desktop app starts the backend (see apps/cli/src/cli/shutdown.ts)
 */
export function server(command: string[], options: { cwd: string; env: Record<string, string> }) {
  const [file, ...args] = command
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  })
  let exitCode: number | null = null
  const exited = new Promise<number>((done, fail) => {
    child.once("error", fail)
    child.once("exit", (code, signal) => {
      exitCode = code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)
      done(exitCode)
    })
  })
  return {
    pid: child.pid,
    exited,
    get exitCode() {
      return exitCode
    },
    /** Reads stdout/stderr to the end; resolves when the stream ends */
    drain: (name: "stdout" | "stderr", write: (text: string) => void) =>
      new Promise<void>((done, fail) => {
        const stream = child[name]!
        stream.setEncoding("utf8")
        stream.on("data", write)
        stream.once("error", fail)
        stream.once("close", () => done())
      }),
    stop() {
      if (exitCode !== null) return
      if (process.platform !== "win32") return void child.kill("SIGTERM")
      if (child.connected) child.disconnect()
    },
    kill(signal: NodeJS.Signals) {
      if (exitCode === null) child.kill(signal)
    },
  }
}

const messages = z.array(
  z.object({
    role: z.string(),
    content: z.unknown().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z
      .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
      .optional(),
  }),
)

export async function until(check: () => unknown | Promise<unknown>, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`I1 timeout: ${label}`)
    await delay(40)
  }
}

/** The process's full command line; undefined when the process is gone or cannot be queried */
async function commandLine(pid: number) {
  if (process.platform === "linux")
    return readFile(`/proc/${pid}/cmdline`, "utf8").then(
      (text) => text.split("\0").join(" "),
      () => undefined,
    )
  const probe =
    process.platform === "win32"
      ? [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ]
      : ["ps", "-p", String(pid), "-o", "command="]
  const result = await Process.run(probe, { nothrow: true })
  const text = result.text().trim()
  return result.exitCode === 0 && text ? text : undefined
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

export function response(text: string, args?: Record<string, unknown>) {
  const delta = args
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `i1-${crypto.randomUUID()}`,
            type: "function",
            function: { name: text, arguments: JSON.stringify(args) },
          },
        ],
      }
    : { role: "assistant", content: text }
  return new Response(
    [
      { id: "i1", object: "chat.completion.chunk", choices: [{ index: 0, delta }] },
      {
        id: "i1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: args ? "tool_calls" : "stop" }],
      },
    ]
      .map((item) => `data: ${JSON.stringify(item)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  )
}

/** Strict synthetic model, real product server/tools/permissions/storage and stdio MCP.
 * Reuses the d6a20546 breadth protocol; never imports Core or drives the engine directly.
 */
export interface ModelTurn {
  model: string
  messages: z.infer<typeof messages>
  input: string
  outputs: { name: string; text: string }[]
  tools: string[]
  definitions: { name: string; description?: string; parameters?: unknown }[]
  project: string
  send: (name: string, args: Record<string, unknown>) => Response
}

export async function sequence(
  kind: "mcp" | "write" | "read",
  fault = false,
  script?: (turn: ModelTurn) => Response | Promise<Response>,
  prepare?: (paths: { root: string; project: string }) => Promise<void>,
  options: { models?: readonly string[]; serverPassword?: string } = {},
) {
  const models = options.models ?? ["qwen-plus"]
  if (!models.length) throw new Error("Sequence requires at least one allowed model")
  const tmp = await tmpdir()
  const root = tmp.path
  const project = join(root, "project")
  for (const dir of ["project", "home", "node_modules", "cache", "data", "logs", "managed", "tmp"])
    await mkdir(join(root, dir), { recursive: true })
  const git = Process.spawn(["git", "init", "--quiet", project], { stdout: "ignore", stderr: "pipe" })
  if (await git.exited) throw new Error("I1 project git init failed")
  await Filesystem.write(join(root, "cache/version"), "21")
  // On Windows directory symlinks need admin rights and junctions do not; other platforms ignore this argument
  await symlink(dirname(fileURLToPath(import.meta.resolve("zod"))), join(root, "node_modules/zod"), "junction")
  const marker = `MARKER_${crypto.randomUUID()}`
  await Filesystem.write(join(project, "input.txt"), marker)
  await Filesystem.write(join(project, "keep.txt"), "KEEP_UNCHANGED")
  if (kind === "read") {
    await Filesystem.write(join(project, "src/a.txt"), marker)
    await Filesystem.write(join(project, "src/calc.ts"), "export const add = (a: number, b: number) => a - b\n")
    await Filesystem.write(join(project, "src/keep.txt"), "KEEP_UNCHANGED")
  }
  await Filesystem.write(join(root, "mcp-marker.txt"), marker)
  await Filesystem.write(
    join(project, "pulse.ts"),
    `import { writeFileSync } from "node:fs"\nwriteFileSync("${join(project, "pulse.pid")}", String(process.pid))\nsetInterval(() => writeFileSync("${join(project, "pulse.txt")}", String(Date.now())), 40)\n`,
  )
  const violations: string[] = []
  const observations: { tools: string[]; resultNames: string[]; action: string }[] = []
  let count = 0
  const model = await Http.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
          throw new Error("unexpected model endpoint")
        const body = z
          .object({
            model: z.string().refine((model) => models.includes(model), "unexpected model"),
            stream: z.literal(true),
            messages,
            tools: z
              .array(
                z.object({
                  function: z.object({
                    name: z.string(),
                    description: z.string().optional(),
                    parameters: z.unknown().optional(),
                  }),
                }),
              )
              .optional(),
          })
          .parse(await request.json())
        if (++count > 24) throw new Error("model request budget exceeded")
        const start = body.messages.findLastIndex((item) => item.role === "user")
        const input = JSON.stringify(body.messages[start]?.content)
        if (!body.tools?.length) return response("I1 auxiliary response")
        const current = body.messages.slice(start + 1)
        const outputs = current
          .filter((item) => item.role === "tool")
          .map((item) => {
            const call = current
              .flatMap((message) => message.tool_calls ?? [])
              .find((call) => call.id === item.tool_call_id)
            if (!call) throw new Error("tool output without matching call identity")
            return { name: call.function.name, text: JSON.stringify(item.content) }
          })
        const available = body.tools?.map((tool) => tool.function.name) ?? []
        const send = (name: string, args: Record<string, unknown>) => {
          if (!available.includes(name)) throw new Error(`missing real tool: ${name}`)
          return response(name, args)
        }
        observations.push({
          tools: available,
          resultNames: outputs.map((item) => item.name),
          action: input.includes("I1_CANCEL") ? "cancel" : input.includes("I1_FOLLOW") ? "follow" : kind,
        })
        if (script)
          return await script({
            model: body.model,
            messages: body.messages,
            input,
            outputs,
            tools: available,
            definitions: body.tools?.map((item) => item.function) ?? [],
            project,
            send,
          })
        if (input.includes("I1_CANCEL")) {
          if (outputs.length) return response("CANCEL_RETURNED")
          return send("bash", {
            command: `exec '${process.execPath}' '${join(project, "pulse.ts")}'`,
            description: "Run the isolated cancellation pulse",
            timeout: 60_000,
          })
        }
        if (kind === "mcp") {
          if (!outputs.length) return send("sequence_lookup", { key: "bad" })
          if (!outputs[0].text.includes("INVALID_KEY")) throw new Error("real MCP error did not reach model")
          if (outputs.length === 1) return send("sequence_lookup", { key: "current" })
          const actual = outputs[1].text.match(/MARKER_[a-f0-9-]+/)?.[0]
          if (!actual) throw new Error("real MCP marker did not reach model")
          return response(`I1_DONE ${fault ? "BROKEN_MARKER" : actual}`)
        }
        if (!outputs.length) return send("read", { filePath: join(project, "input.txt") })
        const actual = outputs[0].text.match(/MARKER_[a-f0-9-]+/)?.[0]
        if (!actual) throw new Error("real read result did not reach model")
        if (kind === "read") return response(`I1_DONE ${actual}`)
        if (input.includes("I1_FOLLOW")) return response(`I1_FOLLOW_DONE ${actual}`)
        if (outputs.length === 1)
          return send("write", {
            filePath: join(project, input.includes("I1_REPEAT") ? "second.txt" : "output.txt"),
            content: fault ? "BROKEN_MARKER" : actual,
          })
        if (!outputs[1].text.includes("Wrote file")) throw new Error("real write did not succeed")
        return response(`I1_DONE ${actual}`)
      } catch (error) {
        violations.push(error instanceof Error ? error.message : String(error))
        return Response.json({ error: { message: "I1_PROTOCOL_VIOLATION" } }, { status: 400 })
      }
    },
  })
  const config = {
    model: "alibaba-cn/qwen-plus",
    small_model: "alibaba-cn/qwen-plus",
    enabled_providers: ["alibaba-cn"],
    provider: { "alibaba-cn": { options: { apiKey: "synthetic-i1", baseURL: `${model.url.origin}/v1` } } },
    memory: { auto_extract: false, auto_recall: false, session_memory: false, auto_dream: false },
    permission: { read: "allow", write: "ask", mcp: "allow" },
    lsp: false,
    ...(kind === "mcp"
      ? {
          mcp: {
            sequence: {
              type: "local",
              command: [...runtime, join(import.meta.dirname, "sdk-sequence-mcp.ts"), root],
              enabled: true,
            },
          },
        }
      : {}),
  }
  await Filesystem.write(join(project, "merakcode.json"), JSON.stringify(config))
  await prepare?.({ root, project }).catch(async (error: unknown) => {
    await model.stop(true)
    throw error
  })
  const env: Record<string, string> = {
    PATH: process.env.PATH!,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    // On Windows os.homedir() reads USERPROFILE, so it points to the isolated directory too.
    // TEMP/TMP stay shared: tsx keeps its transpile cache in the system temp directory, and isolating it would make
    // every child transpile from scratch and double the backend startup time
    USERPROFILE: join(root, "home"),
    // libuv fills in system variables such as SystemRoot when spawning children, node-pty (the engine's terminal)
    // does not. Without SystemRoot, OpenSSL on Windows cannot get entropy and Node crashes on startup
    ...Object.fromEntries(
      ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT"].flatMap((name) =>
        process.platform === "win32" && process.env[name] ? [[name, process.env[name]]] : [],
      ),
    ),
    // The kit root is the MerakCode root: global config at its top, data/, cache/, logs/ and clients/ below
    MERAKCODE_HOME: root,
    MERAKCODE_TEST_HOME: join(root, "home"),
    MERAKCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
    MERAKCODE_I1_NETWORK_LOG: join(root, "blocked-network.txt"),
    MERAKCODE_DISABLE_MODELS_FETCH: "1",
    MERAKCODE_SANDBOX_MODE: "off",
    MERAKCODE_DISABLE_LSP_DOWNLOAD: "1",
    MERAKCODE_DISABLE_CLAUDE_CODE: "1",
    MERAKCODE_DISABLE_EXTERNAL_SKILLS: "1",
    ...(options.serverPassword ? { MERAKCODE_SERVER_PASSWORD: options.serverPassword } : {}),
    MERAKCODE_MODELS_PATH: join(cli, "../../packages/engine/test/tool/fixtures/models-api.json"),
    npm_config_cache: join(root, "cache/npm"),
    HUSKY: "0",
    CI: "1",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
  }
  let output = ""
  let errors = ""
  const port = await Network.freePort()
  const backend = server(product("serve", "--hostname", "127.0.0.1", "--port", String(port)), { cwd: project, env })
  const drains = [
    backend.drain("stdout", (text) => (output += text)),
    backend.drain("stderr", (text) => (errors += text)),
  ]
  const artifacts = process.env.MERAKCODE_I1_EVIDENCE
    ? join(process.env.MERAKCODE_I1_EVIDENCE, `sequence-${crypto.randomUUID()}`)
    : join(root, "evidence")
  const resources: { name: string; pid: number; close: () => Promise<void> }[] = []
  let finishing: Promise<void> | undefined
  const finish = (success: boolean, failure?: unknown) =>
    (finishing ??= close(success, failure !== undefined).then(
      () => {
        if (failure !== undefined) throw failure
      },
      (error) => {
        if (failure !== undefined) throw new AggregateError([failure, error], "Sequence assertion and cleanup failed")
        throw error
      },
    ))
  const close = async (success: boolean, failed: boolean) => {
    const cleanup: string[] = []
    // Registered resources always settle before backend cleanup. A cached resource
    // failure remains red even when recovery later stops every owned process.
    for (const resource of resources)
      await resource.close().catch(() => cleanup.push(`${resource.name} cleanup failed: pid=${resource.pid}`))
    const terminate = (pid: number, signal: "SIGTERM" | "SIGKILL") => {
      try {
        process.kill(pid, signal)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ESRCH")
          cleanup.push(`child termination failed: pid=${pid}; signal=${signal}; code=${code ?? "unknown"}`)
      }
    }
    const summary = {
      kind,
      fault,
      root,
      success, // Legacy assertion result; use overallSuccess for the whole fixture.
      assertionsPassed: success,
      finalizationSucceeded: !failed,
      cleanupSucceeded: false,
      overallSuccess: false,
      forcedRecovery: [] as { pid: number; identified: boolean; signal?: string; exited: boolean }[],
      remainingPIDs: [] as number[],
      backendPID: backend.pid,
      observations,
      violations,
      cleanup,
      exit: null as number | null,
      pids: resources.map((resource) => resource.pid),
    }
    const save = () => Filesystem.write(join(artifacts, "summary.json"), JSON.stringify(summary, null, 2))
    for await (const path of new Glob("**/*.ndjson").scan(join(root, "logs"))) {
      const pid = Number(path.match(/--(\d+)--/)?.[1])
      if (pid) summary.pids.push(pid)
    }
    await save()
    backend.stop()
    const exit = await Promise.race([backend.exited, delay(8000).then(() => "timeout")])
    if (exit === "timeout") {
      cleanup.push("backend required SIGKILL")
      backend.kill("SIGKILL")
      summary.forcedRecovery.push({ pid: backend.pid!, identified: true, signal: "SIGKILL", exited: false })
    }
    summary.exit = await backend.exited
    if (summary.exit !== 0) cleanup.push(`backend exited unexpectedly: code=${summary.exit}`)
    for (const item of summary.forcedRecovery) item.exited = !alive(item.pid)
    await Promise.all(drains)
    await model.stop(true)
    const ledger = await Filesystem.readText(join(root, "mcp.jsonl")).catch(() => "")
    summary.pids.push(
      ...ledger
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).pid as number),
    )
    const pulse = Number(await Filesystem.readText(join(project, "pulse.pid")).catch(() => "0"))
    if (pulse) summary.pids.push(pulse)
    await save()
    await until(
      () => [...new Set(summary.pids)].every((pid) => !alive(pid)),
      "owned tool/MCP processes exited",
      5000,
    ).catch(() => cleanup.push("owned child PID still alive"))
    // Never persist command text; only the requested ledger PID may authorize a signal.
    // The fixture root name is random: only a command line containing it belongs to this fixture (PIDs may be reused)
    const identify = async (pid: number) =>
      Number.isSafeInteger(pid) && pid > 0 && Boolean((await commandLine(pid))?.includes(basename(root)))
    // A failed product cleanup remains a failure even when fixture recovery succeeds.
    // Only ledger PIDs whose current command still names this unique root are eligible.
    for (const pid of [...new Set(summary.pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0 && alive(pid))) {
      const identified = await identify(pid)
      const recovery = { pid, identified, signal: undefined as string | undefined, exited: !alive(pid) }
      summary.forcedRecovery.push(recovery)
      await save()
      if (!identified || recovery.exited) continue
      recovery.signal = "SIGTERM"
      terminate(pid, "SIGTERM")
      await until(() => !alive(pid), "identified fixture child recovery", 3000).catch(() => undefined)
      // Reconfirm identity before escalation; never kill an unrelated recycled PID.
      if (alive(pid) && (await identify(pid))) {
        recovery.signal = "SIGKILL"
        terminate(pid, "SIGKILL")
        await until(() => !alive(pid), "identified fixture child forced exit", 3000).catch(() => undefined)
      }
      recovery.exited = !alive(pid)
    }
    summary.remainingPIDs = [...new Set(summary.pids)].filter((pid) => alive(pid))
    summary.cleanupSucceeded = cleanup.length === 0 && summary.remainingPIDs.length === 0
    summary.overallSuccess = summary.assertionsPassed && summary.cleanupSucceeded && summary.finalizationSucceeded
    await save()
    if (!summary.cleanupSucceeded) throw new Error(`I1 cleanup failed; summary=${join(artifacts, "summary.json")}`)
    // A product process that has only just exited can still be closing files under root, so rmdir meets ENOTEMPTY
    if (summary.overallSuccess) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  try {
    await until(
      () => {
        if (backend.exitCode !== null)
          throw new Error(`server exited before ready: code=${backend.exitCode}; stderrBytes=${errors.length}`)
        return /listening on (http:\/\/127\.0\.0\.1:\d+)/.test(output)
      },
      "real product server listening",
      45_000,
    )
  } catch (error) {
    await finish(false)
    throw error
  }
  const url = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)![1]
  async function api(route: string, method = "GET", body?: unknown) {
    const result = await fetch(`${url}${route}`, {
      method,
      signal: AbortSignal.timeout(25_000),
      headers: { "Content-Type": "application/json", "x-merakcode-directory": project },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!result.ok) throw new Error(`${method} ${route}: ${result.status}`)
    const text = await result.text()
    return text ? JSON.parse(text) : undefined
  }
  return {
    root,
    project,
    url,
    env,
    marker,
    artifacts,
    api,
    finish,
    registerCleanup(name: string, pid: number, close: () => Promise<void>) {
      if (finishing) throw new Error("Cannot register a resource during fixture shutdown")
      resources.push({ name, pid, close })
    },
    violations,
    observations,
    modelRequests: () => count,
    async stopBackend() {
      backend.stop()
      const code = await Promise.race([backend.exited, delay(8000).then(() => "timeout")])
      if (code !== 0) throw new Error("Fixture backend handoff did not exit cleanly")
      await Promise.all(drains)
    },
    config: () => readFile(join(project, "merakcode.json"), "utf8"),
    async stopped(sessionID: string, userID: string, tool: string) {
      await until(
        async () => {
          const history = await api(`/session/${sessionID}/message`)
          const current = history.filter(
            (item: { info: { role: string; parentID?: string } }) =>
              item.info.role === "assistant" && item.info.parentID === userID,
          )
          const parts = current.flatMap(
            (item: { parts: { tool?: string; state?: { status: string } }[] }) => item.parts,
          )
          return (
            current.length > 0 &&
            current.every((item: { info: { time: { completed?: number } } }) => item.info.time.completed) &&
            parts.some(
              (part: { tool?: string; state?: { status: string } }) =>
                part.tool === tool && part.state?.status === "error",
            ) &&
            !parts.some((part: { state?: { status: string } }) =>
              ["running", "pending"].includes(part.state?.status ?? ""),
            )
          )
        },
        "current rejected/cancelled tool terminal",
        10_000,
      )
    },
    async submitted(sessionID: string, text: string) {
      const history = await api(`/session/${sessionID}/message`)
      const found = history.filter(
        (item: { info: { role: string }; parts: { text?: string }[] }) =>
          item.info.role === "user" && item.parts.some((part) => part.text === text),
      )
      if (found.length !== 1) throw new Error("I1_ORACLE: submitted input identity is not unique")
      return found[0].info.id as string
    },
    async assertResult(
      sessionID: string,
      userID: string,
      text = "I1_DONE",
      expectedErrors = 0,
      expectedMessageErrors: readonly string[] = [],
      options: { verifyFileEffect?: boolean } = {},
    ) {
      const schema = z.array(
        z.object({
          info: z.object({
            id: z.string(),
            sessionID: z.string(),
            role: z.string(),
            time: z.object({ completed: z.number().optional() }),
            parentID: z.string().optional(),
            error: z.unknown().optional(),
          }),
          parts: z.array(
            z
              .object({
                id: z.string(),
                type: z.string(),
                sessionID: z.string(),
                messageID: z.string(),
                text: z.string().optional(),
                state: z.object({ status: z.string() }).passthrough().optional(),
              })
              .passthrough(),
          ),
        }),
      )
      let samples = 0
      let first: { assistants: number; incomplete: number; active: number; status: string } | undefined
      let last: typeof first
      let ready = false
      try {
        await until(
          async () => {
            const pending = schema
              .parse(await api(`/session/${sessionID}/message`))
              .filter((item) => item.info.role === "assistant" && item.info.parentID === userID)
            const status = (await api("/session/status"))[sessionID]?.type ?? "idle"
            const state = {
              assistants: pending.length,
              incomplete: pending.filter((item) => !item.info.time.completed).length,
              active: pending
                .flatMap((item) => item.parts)
                .filter((part) => ["pending", "running"].includes(part.state?.status ?? "")).length,
              status,
            }
            samples++
            first ??= state
            last = state
            return state.assistants > 0 && state.incomplete === 0 && state.active === 0
          },
          "exact result parent reaches terminal readiness",
          15_000,
        )
        ready = true
      } finally {
        await Filesystem.write(
          join(artifacts, `readiness-${userID}.json`),
          JSON.stringify({ sessionID, userID, samples, first, last, ready }),
        )
      }
      // Completion readiness is separate from the strict one-shot result oracle below.
      const history = schema.parse(await api(`/session/${sessionID}/message`))
      if (!history.some((item) => item.info.role === "user" && item.info.id === userID))
        throw new Error("I1_ORACLE: user missing")
      const current = history.filter((item) => item.info.role === "assistant" && item.info.parentID === userID)
      const errors = current
        .filter((item) => item.info.error !== undefined)
        .map((item) => z.object({ name: z.string() }).parse(item.info.error).name)
        .sort()
      if (JSON.stringify(errors) !== JSON.stringify([...expectedMessageErrors].sort()))
        throw new Error("I1_ORACLE: unexpected message error names or count")
      if (!current.some((item) => item.parts.some((part) => part.text?.includes(`${text} ${marker}`))))
        throw new Error("I1_ORACLE: missing visible result from real marker")
      for (const item of current) {
        if (item.info.sessionID !== sessionID || !item.info.time.completed)
          throw new Error("I1_ORACLE: wrong message ownership")
        for (const part of item.parts)
          if (
            part.sessionID !== sessionID ||
            part.messageID !== item.info.id ||
            ["running", "pending"].includes(part.state?.status ?? "")
          )
            throw new Error("I1_ORACLE: unresolved or misowned part")
      }
      assertPersisted(current, stored(root, sessionID))
      if (
        kind === "write" &&
        options.verifyFileEffect !== false &&
        (await Filesystem.readText(join(project, "output.txt"))) !== marker
      )
        throw new Error("I1_ORACLE: wrong file effect")
      if (
        kind !== "mcp" &&
        current.flatMap((item) => item.parts).filter((part) => part.state?.status === "error").length !== expectedErrors
      )
        throw new Error("I1_ORACLE: unexpected failed tool count in successful turn")
      if ((await Filesystem.readText(join(project, "keep.txt"))) !== "KEEP_UNCHANGED")
        throw new Error("I1_ORACLE: protected file changed")
      if (violations.length) throw new Error(violations.join("; "))
      await Filesystem.write(
        join(artifacts, `identity-${userID}.json`),
        JSON.stringify(
          {
            sessionID,
            userID,
            markerHash: createHash("sha256").update(marker).digest("hex"),
            assistants: current.map((item) => ({
              id: item.info.id,
              parentID: item.info.parentID,
              parts: item.parts.map((part) => ({
                type: part.type,
                messageID: part.messageID,
                status: part.state?.status,
                length: part.text?.length,
              })),
            })),
          },
          null,
          2,
        ),
      )
      return current
    },
  }
}

if (import.meta.main) {
  const kit = await sequence("write", process.env.MERAKCODE_I1_FAULT === "1")
  console.log(
    JSON.stringify({
      root: kit.root,
      project: kit.project,
      url: kit.url,
      marker: kit.marker,
      artifacts: kit.artifacts,
    }),
  )
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void kit.finish(false).then(
        () => process.exit(0),
        () => process.exit(1),
      )
    })
  try {
    for await (const line of createInterface({ input: process.stdin })) {
      const message = JSON.parse(line)
      if (message.close !== undefined) {
        await kit.finish(message.close)
        break
      }
      try {
        if (message.stopped) await kit.stopped(message.sessionID, message.userID, message.stopped)
        else await kit.assertResult(message.sessionID, message.userID)
        console.log(JSON.stringify({ checked: true }))
      } catch (error) {
        console.log(JSON.stringify({ checked: false, error: String(error) }))
      }
    }
  } finally {
    await kit.finish(false)
  }
}
