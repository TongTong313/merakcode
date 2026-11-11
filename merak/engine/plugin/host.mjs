// The MerakCode plugin host. The engine runs this file with Node, once for each conversation that has plugins, and
// talks to it with one JSON message per line on stdin and stdout. Plugins write to stderr only.
import { execFile } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import readline from "node:readline"
import { pathToFileURL } from "node:url"

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")
for (const name of ["log", "info", "debug", "warn"]) console[name] = (...args) => console.error(...args)

const SUPPORTED = new Set([
  "event",
  "tool",
  "chat.message",
  "chat.params",
  "permission.ask",
  "tool.execute.before",
  "tool.execute.after",
  "tool.definition",
  "shell.env",
])

const plugins = []
let context = {}

const errorText = (error) => (error instanceof Error ? error.message : String(error))

function shell(directory) {
  const run = (parts, values) => {
    const command = parts.reduce(
      (text, part, index) => text + part + (index < values.length ? String(values[index]) : ""),
      "",
    )
    const result = new Promise((resolve, reject) => {
      const [program, args] =
        process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", command]] : ["/bin/sh", ["-c", command]]
      execFile(program, args, { cwd: directory, encoding: "buffer", maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
        const output = {
          stdout,
          stderr,
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          text: () => stdout.toString("utf8"),
          json: () => JSON.parse(stdout.toString("utf8")),
        }
        if (error && !error.killed && typeof error.code !== "number") reject(error)
        else resolve(output)
      })
    })
    return Object.assign(result, {
      quiet: () => result,
      nothrow: () => result,
      text: () => result.then((value) => value.text()),
    })
  }
  return (parts, ...values) => run(parts, values)
}

function resolveSpec(spec, cache) {
  if (spec.startsWith("file://")) return new URL(spec)
  if (path.isAbsolute(spec) || spec.startsWith(".")) return pathToFileURL(path.resolve(context.directory, spec))
  const require = createRequire(path.join(cache, "package.json"))
  const entry = require.resolve(spec)
  return pathToFileURL(entry)
}

async function toSchema(args, base) {
  if (!args) return { type: "object", additionalProperties: true }
  if (args.type === "object" || args.properties) return args
  try {
    const { z } = await import(pathToFileURL(createRequire(base).resolve("zod")).href)
    return z.toJSONSchema(z.object(args))
  } catch {
    return { type: "object", additionalProperties: true }
  }
}

async function load(item) {
  const status = {
    spec: item.spec,
    id: path.basename(item.spec).replace(/\.[^.]*$/, ""),
    status: "loaded",
    hooks: [],
    ignored: [],
    tools: [],
  }
  try {
    const location = resolveSpec(item.spec, context.cache)
    const loaded = await import(location.href)
    const entries = [["default", loaded.default], ...Object.entries(loaded).filter(([name]) => name !== "default")]
    const seen = new Set()
    const hooks = []
    const options = { ...(item.options ?? {}) }
    const input = {
      directory: context.directory,
      worktree: context.worktree,
      project: { worktree: context.worktree },
      serverUrl: new URL(context.serverUrl),
      $: shell(context.directory),
      options,
      dataDirectory: path.join(context.dataRoot, status.id),
    }
    for (const [, value] of entries) {
      if (typeof value === "function" && !seen.has(value)) {
        seen.add(value)
        hooks.push(await value(input, options))
      } else if (value && typeof value === "object" && typeof value.server === "function" && !seen.has(value.server)) {
        seen.add(value.server)
        if (value.id) status.id = String(value.id)
        hooks.push(await value.server({ ...input, options: { ...(value.options ?? {}), ...options } }, options))
      }
    }
    const merged = {}
    const tools = {}
    for (const found of hooks.filter((hook) => hook && typeof hook === "object")) {
      for (const [name, value] of Object.entries(found)) {
        if (name === "tool" && value && typeof value === "object") Object.assign(tools, value)
        else if (typeof value === "function") merged[name] = [...(merged[name] ?? []), value]
        else if (name !== "tool") merged[name] = merged[name] ?? [value]
      }
    }
    const base =
      location.protocol === "file:" ? new URL(location).pathname.replace(/^\/([A-Za-z]:)/, "$1") : context.directory
    for (const [name, definition] of Object.entries(tools)) {
      status.tools.push({
        name,
        description: String(definition.description ?? ""),
        schema: await toSchema(definition.args, base),
      })
    }
    const names = Object.keys(merged)
    if (status.tools.length) names.push("tool")
    status.hooks = names.filter((name) => SUPPORTED.has(name)).sort()
    status.ignored = names.filter((name) => !SUPPORTED.has(name)).sort()
    plugins.push({ id: status.id, hooks: merged, tools })
  } catch (error) {
    status.status = "failed"
    status.error = errorText(error)
  }
  return status
}

// within gives a hook the time the engine allows; a hook that does not answer fails alone.
function within(work) {
  let timer
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), context.hookTimeout ?? 10000)
  })
  return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

async function callHook(name, input, output) {
  const failures = []
  for (const plugin of plugins) {
    for (const hook of plugin.hooks[name] ?? []) {
      if (typeof hook !== "function") continue
      try {
        await within(hook(input, output))
      } catch (error) {
        failures.push({ plugin: plugin.id, error: errorText(error) })
      }
    }
  }
  return { output, failures }
}

const handlers = {
  async init(params) {
    context = params.context
    fs.mkdirSync(context.cache, { recursive: true })
    const statuses = []
    for (const item of params.plugins) statuses.push(await load(item))
    return statuses
  },
  hook: (params) => callHook(params.name, params.input, params.output),
  async tool(params) {
    const plugin = plugins.find((candidate) => candidate.id === params.plugin)
    const definition = plugin?.tools[params.name]
    if (!definition || typeof definition.execute !== "function")
      throw new Error("unknown plugin tool " + params.plugin + "/" + params.name)
    const controller = new AbortController()
    const result = await definition.execute(params.args, {
      sessionID: params.context?.session ?? "",
      messageID: params.context?.call ?? "",
      callID: params.context?.call ?? "",
      agent: "build",
      directory: context.directory,
      worktree: context.worktree,
      abort: controller.signal,
      metadata: () => {},
      ask: async () => {},
    })
    if (typeof result === "string") return { output: result }
    return { output: String(result?.output ?? "") }
  },
  async event(params) {
    await callHook("event", { event: params.event }, {})
    return null
  },
  async dispose() {
    for (const plugin of plugins) {
      for (const hook of plugin.hooks.dispose ?? []) {
        try {
          await hook()
        } catch {}
      }
    }
    return null
  },
}

const lines = readline.createInterface({ input: process.stdin })
lines.on("line", (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  const handler = handlers[request.method]
  Promise.resolve()
    .then(() => {
      if (!handler) throw new Error("unknown method " + request.method)
      return handler(request.params ?? {})
    })
    .then(
      (result) => request.id !== undefined && send({ id: request.id, result: result ?? null }),
      (error) => request.id !== undefined && send({ id: request.id, error: errorText(error) }),
    )
})
lines.on("close", () => process.exit(0))
