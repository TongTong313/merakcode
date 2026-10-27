// Execution logic and heavy dependencies of the run command.
//
// This module holds the heavy dependencies (@merakcode/sdk and friends), the tool rendering helpers and the handler.
// The run.ts shell loads it with `await import("./run.handler")` only when the command runs, which keeps them out of
// CLI startup. Shared pure helpers come from ./run.shared, not ./run, to avoid a circular import.

import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { text as streamText } from "stream/consumers"
import { UI } from "../ui"
import { I18n } from "../i18n"
import { EOL } from "os"
import {
  createMerakCodeClient,
  type MerakCodeClient,
  type PermissionRuleset,
  type ToolPart,
} from "@merakcode/sdk/client"
import { parseModel } from "@merakcode/util/model"
import { withEngine } from "../engine"
import type { ToolInput, ToolMetadata, ToolView } from "./tool-view"
import { Locale } from "@merakcode/util/locale"
import { Filesystem } from "@merakcode/util/filesystem"
import { Patch } from "@merakcode/util/patch"
import { Log } from "@merakcode/log/logger"
import { permissionDeniedCopy, runDirectoryFailure, selectContinueSession } from "./run.shared"

// Arguments of the run handler, matching the RunCommand builder. The run.ts shell passes the yargs-inferred args,
// which are a structural superset of this type.
type RunArgs = {
  message: string[]
  command?: string
  continue?: boolean
  session?: string
  fork?: boolean
  model?: string
  agent?: string
  format: string
  file?: string | string[]
  title?: string
  attach?: string
  dir?: string
  port?: number
  variant?: string
  thinking?: boolean
  auto?: boolean
  "--"?: string[]
}

type ToolProps<Name extends keyof ToolView> = {
  input: ToolInput<Name>
  metadata: ToolMetadata<Name>
  part: ToolPart
}

function props<Name extends keyof ToolView>(part: ToolPart): ToolProps<Name> {
  const state = part.state
  return {
    input: state.input as ToolInput<Name>,
    metadata: ("metadata" in state ? state.metadata : {}) as ToolMetadata<Name>,
    part,
  }
}

type Inline = {
  icon: string
  title: string
  description?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function fallback(part: ToolPart) {
  const state = part.state
  const input = "input" in state ? state.input : undefined
  const title =
    ("title" in state && state.title ? state.title : undefined) ||
    (input && typeof input === "object" && Object.keys(input).length > 0 ? JSON.stringify(input) : "Unknown")
  inline({
    icon: "⚙",
    title: `${part.tool} ${title}`,
  })
}

function glob(info: ToolProps<"glob">) {
  const root = info.input.path ?? ""
  const title = `Glob "${info.input.pattern}"`
  const suffix = root ? `in ${normalizePath(root)}` : ""
  const num = info.metadata.count
  const description =
    num === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${num} ${num === 1 ? "match" : "matches"}`
  inline({
    icon: "✱",
    title,
    ...(description && { description }),
  })
}

function grep(info: ToolProps<"grep">) {
  const root = info.input.path ?? ""
  const title = `Grep "${info.input.pattern}"`
  const suffix = root ? `in ${normalizePath(root)}` : ""
  const num = info.metadata.matches
  const description =
    num === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${num} ${num === 1 ? "match" : "matches"}`
  inline({
    icon: "✱",
    title,
    ...(description && { description }),
  })
}

function list(info: ToolProps<"ls">) {
  const dir = info.input.path ? normalizePath(info.input.path) : ""
  inline({
    icon: "→",
    title: dir ? `List ${dir}` : "List",
  })
}

function read(info: ToolProps<"read">) {
  const file = normalizePath(info.input.filePath)
  const pairs = Object.entries(info.input).filter(([key, value]) => {
    if (key === "filePath") return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  const description = pairs.length ? `[${pairs.map(([key, value]) => `${key}=${value}`).join(", ")}]` : undefined
  inline({
    icon: "→",
    title: `Read ${file}`,
    ...(description && { description }),
  })
}

function write(info: ToolProps<"write">) {
  block(
    {
      icon: "←",
      title: `Write ${normalizePath(info.input.filePath)}`,
    },
    info.part.state.status === "completed" ? info.part.state.output : undefined,
  )
}

function webfetch(info: ToolProps<"webfetch">) {
  inline({
    icon: "%",
    title: `WebFetch ${info.input.url}`,
  })
}

function edit(info: ToolProps<"edit"> | ToolProps<"multi_edit">) {
  const title = normalizePath(info.input.filePath)
  block(
    {
      icon: "←",
      title: `Edit ${title}`,
    },
    info.metadata.diff && Patch.hunks(info.metadata.diff),
  )
}

function codesearch(info: ToolProps<"codesearch">) {
  inline({
    icon: "◇",
    title: `Exa Code Search "${info.input.query}"`,
  })
}

function websearch(info: ToolProps<"websearch">) {
  inline({
    icon: "◈",
    title: `Exa Web Search "${info.input.query}"`,
  })
}

function subagent(info: ToolProps<"subagent">) {
  const agent = Locale.titlecase(info.input.subagent_type ?? "")
  const desc = info.input.description
  const status = info.part.state.status
  // SubAgentTool pushes the phase through ctx.metadata: queued → executing → (status becomes completed).
  const phase = (info.metadata as any)?.phase as "queued" | "executing" | undefined
  const name = desc ?? `${agent} Subagent`
  const agentDesc = desc ? `${agent} Agent` : undefined

  if (status === "completed") {
    // Print the subagent output (task_id + <task_result>) as a block so scripts can consume it.
    block({ icon: "✓", title: name, description: agentDesc }, info.part.state.output?.trim())
    return
  }
  // While running, the icon reflects the phase: queued or executing.
  inline({
    icon: phase === "queued" ? "⏳" : "•",
    title: name,
    description: agentDesc,
  })
}

function skill(info: ToolProps<"skill">) {
  inline({
    icon: "→",
    title: `Skill "${info.input.name}"`,
  })
}

function bash(info: ToolProps<"bash">) {
  const output = info.part.state.status === "completed" ? info.part.state.output?.trim() : undefined
  block(
    {
      icon: "$",
      title: `${info.input.command}`,
    },
    output,
  )
}

function todo(info: ToolProps<"todowrite">) {
  block(
    {
      icon: "#",
      title: "Todos",
    },
    (info.input.todos ?? []).map((item) => `${item.status === "completed" ? "[x]" : "[ ]"} ${item.content}`).join("\n"),
  )
}

function normalizePath(input?: string) {
  if (!input) return ""
  if (path.isAbsolute(input)) return path.relative(process.cwd(), input) || "."
  return input
}

export async function run(args: RunArgs) {
  const log = Log.create({ service: "cli.run", source: "product" })
  function rejectResume(message: string, reason: string, sessionID = args.session) {
    log.warn("resume rejected", { sessionID, stage: "cli.resume", reason })
    if (args.format === "json") {
      process.stdout.write(
        JSON.stringify({
          type: "error",
          timestamp: Date.now(),
          sessionID,
          error: { name: "Error", data: { message } },
        }) + EOL,
      )
    } else {
      UI.error(message)
    }
    process.exitCode = 1
    return null
  }

  if (args.continue && args.session) {
    rejectResume(I18n.t("cli.run.conflictingFlags"), "conflicting_flags")
    return
  }

  let message = [...args.message, ...(args["--"] || [])]
    .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    .join(" ")

  const directory = (() => {
    if (!args.dir) return undefined
    if (args.attach) return args.dir
    try {
      process.chdir(args.dir)
      return process.cwd()
    } catch (error) {
      if (args.continue || args.session) {
        const failure = runDirectoryFailure(error, args.dir)
        return rejectResume(failure.message, failure.reason)
      }
      UI.error(I18n.t("cli.chdirFailed", { cwd: args.dir }))
      process.exit(1)
    }
  })()
  if (directory === null) return

  const files: { type: "file"; url: string; filename: string; mime: string }[] = []
  if (args.file) {
    const list = Array.isArray(args.file) ? args.file : [args.file]

    for (const filePath of list) {
      const resolvedPath = path.resolve(process.cwd(), filePath)
      const stats = await fs.stat(resolvedPath).catch(() => {})
      if (!stats) {
        UI.error(I18n.t("cli.run.fileNotFound", { path: filePath }))
        process.exit(1)
      }
      // A directory is also reported as file not found.
      if (!(await Filesystem.isFile(resolvedPath))) {
        UI.error(I18n.t("cli.run.fileNotFound", { path: filePath }))
        process.exit(1)
      }

      const stat = await fs.stat(resolvedPath)
      const mime = stat.isDirectory() ? "application/x-directory" : "text/plain"

      files.push({
        type: "file",
        url: pathToFileURL(resolvedPath).href,
        filename: path.basename(resolvedPath),
        mime,
      })
    }
  }

  // Without a TTY, append piped input (echo xxx | merak run ...) to the message. stdin may be redirected to an
  // unreadable descriptor (nohup, < /dev/null, etc.), where reading throws EBADF; treat that as no piped input so
  // unattended runs do not crash.
  if (!process.stdin.isTTY) {
    try {
      const piped = await streamText(process.stdin)
      if (piped) message += "\n" + piped
    } catch {
      // Unreadable stdin: treat as no piped input.
    }
  }

  if (message.trim().length === 0 && !args.command) {
    UI.error(I18n.t("cli.run.needMessage"))
    process.exit(1)
  }

  if (args.fork && !args.continue && !args.session) {
    UI.error(I18n.t("cli.forkRequires"))
    process.exit(1)
  }

  // Auto mode notice; skipped for JSON output to keep it machine-readable.
  if (args.auto && args.format !== "json") {
    UI.println(
      UI.Style.TEXT_WARNING_BOLD + I18n.t("cli.run.auto.title"),
      UI.Style.TEXT_NORMAL + I18n.t("cli.run.auto.notice"),
    )
  }

  // Must be set before bootstrap and the SDK client: Flag.MERAKCODE_NONINTERACTIVE is a runtime getter that reads it.
  process.env.MERAKCODE_NONINTERACTIVE = "true"

  const rules: PermissionRuleset = [
    {
      permission: "question",
      action: "deny",
      pattern: "*",
    },
    {
      permission: "plan_enter",
      action: "deny",
      pattern: "*",
    },
    {
      permission: "plan_exit",
      action: "deny",
      pattern: "*",
    },
  ]

  function title() {
    if (args.title === undefined) return
    if (args.title !== "") return args.title
    return message.slice(0, 50) + (message.length > 50 ? "..." : "")
  }

  async function resume(sdk: MerakCodeClient) {
    try {
      // With --attach the directory belongs to the server; it cannot be inferred from the local cwd or stat.
      const scope = args.attach ? (await sdk.path.get(undefined, { throwOnError: true })).data.directory : process.cwd()
      if (!scope) return rejectResume(I18n.t("cli.run.serverDirectoryFailed"), "directory_lookup_failed")

      const selected = await (async () => {
        if (args.continue) {
          const result = await sdk.session.list({ directory: scope, roots: true }, { throwOnError: true })
          return selectContinueSession(result.data, scope)
        }
        const result = await sdk.session.get({ sessionID: args.session! })
        if (result.response?.status === 404) return undefined
        if (result.error || !result.response?.ok) throw new Error("Session lookup failed")
        if (!result.data) throw new Error("Session metadata missing")
        return result.data
      })()
      if (!selected) {
        return rejectResume(
          args.continue ? I18n.t("cli.run.noContinuableSession") : I18n.t("cli.run.sessionNotFound"),
          "session_missing",
        )
      }
      if (!selected.directory) {
        return rejectResume(I18n.t("cli.run.sessionNoDirectory"), "directory_missing_metadata", selected.id)
      }
      if (!Filesystem.sameDirectory(selected.directory, scope)) {
        return rejectResume(
          I18n.t("cli.run.directoryMismatch", { directory: selected.directory }),
          "directory_mismatch",
          selected.id,
        )
      }
      if (!args.attach) {
        try {
          const stat = await fs.stat(selected.directory)
          if (!stat.isDirectory()) {
            return rejectResume(I18n.t("cli.run.notDirectory"), "not_directory", selected.id)
          }
        } catch (error) {
          const failure = runDirectoryFailure(error)
          return rejectResume(failure.message, failure.reason, selected.id)
        }
      }
      log.info("resume selected", {
        sessionID: selected.id,
        stage: "cli.resume",
        mode: args.continue ? "continue" : "session",
      })
      return selected.id
    } catch {
      return rejectResume(I18n.t("cli.run.sessionLookupFailed"), "session_lookup_failed")
    }
  }

  async function session(sdk: MerakCodeClient, baseID?: string) {
    if (baseID && args.fork) {
      const forked = await sdk.session.fork({ sessionID: baseID })
      return forked.data?.id
    }

    if (baseID) return baseID

    const name = title()
    const result = await sdk.session.create({ title: name, permission: rules })
    return result.data?.id
  }

  async function execute(sdk: MerakCodeClient) {
    const baseID = args.continue || args.session ? await resume(sdk) : undefined
    if (baseID === null) return

    function tool(part: ToolPart) {
      if (part.tool === "bash") return bash(props<"bash">(part))
      if (part.tool === "glob") return glob(props<"glob">(part))
      if (part.tool === "grep") return grep(props<"grep">(part))
      if (part.tool === "ls") return list(props<"ls">(part))
      if (part.tool === "read") return read(props<"read">(part))
      if (part.tool === "write") return write(props<"write">(part))
      if (part.tool === "webfetch") return webfetch(props<"webfetch">(part))
      if (part.tool === "edit") return edit(props<"edit">(part))
      if (part.tool === "multi_edit") return edit(props<"multi_edit">(part))
      if (part.tool === "codesearch") return codesearch(props<"codesearch">(part))
      if (part.tool === "websearch") return websearch(props<"websearch">(part))
      if (part.tool === "subagent") return subagent(props<"subagent">(part))
      if (part.tool === "todowrite") return todo(props<"todowrite">(part))
      if (part.tool === "skill") return skill(props<"skill">(part))
      return fallback(part)
    }

    function emit(type: string, data: Record<string, unknown>) {
      if (args.format === "json") {
        process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL)
        return true
      }
      return false
    }

    const events = await sdk.event.subscribe()
    let error: string | undefined

    async function loop() {
      const toggles = new Map<string, boolean>()

      /** Non-interactive rejection: emits the event, prints the notice and replies with reject. */
      async function rejectPermission(input: {
        requestID: string
        emitPayload: Record<string, unknown>
        uiLine: string
        message: string
      }) {
        if (!emit("permission_denied", input.emitPayload)) {
          UI.println(UI.Style.TEXT_WARNING_BOLD + "!", UI.Style.TEXT_NORMAL + input.uiLine)
        }
        await sdk.permission.reply({
          requestID: input.requestID,
          reply: "reject",
          message: input.message,
        })
      }

      for await (const event of events.stream) {
        if (
          event.type === "message.updated" &&
          event.properties.info.role === "assistant" &&
          args.format !== "json" &&
          toggles.get("start") !== true
        ) {
          UI.empty()
          const info = event.properties.info
          UI.println(
            "agent" in info
              ? `> ${info.agent} · ${info.modelID}`
              : `> ${info.execution.productTitle}${info.execution.actualModel ? ` · ${info.execution.actualModel.id}` : ""}`,
          )
          UI.empty()
          toggles.set("start", true)
        }

        if (event.type === "message.part.updated") {
          const part = event.properties.part
          if (part.sessionID !== sessionID) continue

          if (part.type === "tool" && part.state.status === "completed") {
            if (emit("tool_use", { part })) continue
            tool(part)
          }

          // Print running subagents once per phase (queued, executing); completion goes through the generic tool output
          // above.
          if (
            part.type === "tool" &&
            part.tool === "subagent" &&
            part.state.status === "running" &&
            args.format !== "json"
          ) {
            const phase = (part.state.metadata as any)?.phase as string | undefined
            const key = `subagent:${part.id}:${phase ?? "running"}`
            if (toggles.get(key) === true) continue
            subagent(props<"subagent">(part))
            toggles.set(key, true)
          }

          if (part.type === "step-start") {
            if (emit("step_start", { part })) continue
          }

          if (part.type === "step-finish") {
            if (emit("step_finish", { part })) continue
          }

          if (part.type === "text" && part.time?.end) {
            if (emit("text", { part })) continue
            const text = part.text.trim()
            if (!text) continue
            if (!process.stdout.isTTY) {
              process.stdout.write(text + EOL)
              continue
            }
            UI.empty()
            UI.println(text)
            UI.empty()
          }

          if (part.type === "reasoning" && part.time?.end && args.thinking) {
            if (emit("reasoning", { part })) continue
            const text = part.text.trim()
            if (!text) continue
            const line = `Thinking: ${text}`
            if (process.stdout.isTTY) {
              UI.empty()
              UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
              UI.empty()
              continue
            }
            process.stdout.write(line + EOL)
          }
        }

        if (event.type === "session.error") {
          const props = event.properties
          if (props.sessionID !== sessionID || !props.error) continue
          let err = String(props.error.name)
          if ("data" in props.error && props.error.data && "message" in props.error.data) {
            err = String(props.error.data.message)
          }
          error = error ? error + EOL + err : err
          if (emit("error", { error: props.error })) continue
          UI.error(err)
        }

        if (
          event.type === "session.status" &&
          event.properties.sessionID === sessionID &&
          event.properties.status.type === "idle"
        ) {
          break
        }

        if (event.type === "permission.asked") {
          const permission = event.properties
          if (permission.sessionID !== sessionID) continue

          // Nobody can approve: reject every request that asks (including high-risk actions auto mode leaves to a
          // human) and pass the reason to the agent.
          const copy = permissionDeniedCopy(permission.permission, permission.patterns)
          await rejectPermission({
            requestID: permission.id,
            emitPayload: {
              permission: permission.permission,
              patterns: permission.patterns,
              reason: "non_interactive",
            },
            uiLine: copy.uiLine,
            message: copy.message,
          })
        }

        if (event.type === "question.asked") {
          const q = event.properties
          if (q.sessionID !== sessionID) continue
          if (!emit("question_rejected", { requestID: q.id, reason: "non_interactive" })) {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL + I18n.t("cli.run.questionRejected", { id: q.id }),
            )
          }
          await sdk.question.reject({ requestID: q.id })
        }
      }
    }

    // Validate agent if specified
    const agent = await (async () => {
      if (!args.agent) return undefined
      const entry = (await sdk.app.agents()).data?.find((item) => item.id === args.agent)
      if (!entry) {
        UI.println(
          UI.Style.TEXT_WARNING_BOLD + "!",
          UI.Style.TEXT_NORMAL,
          I18n.t("cli.run.agentNotFound", { agent: args.agent }),
        )
        return undefined
      }
      if (entry.mode === "subagent") {
        UI.println(
          UI.Style.TEXT_WARNING_BOLD + "!",
          UI.Style.TEXT_NORMAL,
          I18n.t("cli.run.agentIsSubagent", { agent: args.agent }),
        )
        return undefined
      }
      return args.agent
    })()

    const sessionID = await session(sdk, baseID)
    if (!sessionID) {
      UI.error(I18n.t("cli.run.sessionNotFound"))
      process.exit(1)
    }

    loop().catch(async (e) => {
      console.error(e)
      process.exit(1)
    })

    if (args.command) {
      await sdk.session.command({
        sessionID,
        agent,
        model: args.model,
        command: args.command,
        arguments: message,
        variant: args.variant,
        permissionMode: args.auto ? "auto" : undefined,
      })
    } else {
      const model = args.model ? parseModel(args.model) : undefined
      await sdk.session.prompt({
        sessionID,
        agent,
        model,
        variant: args.variant,
        parts: [...files, { type: "text", text: message }],
        permissionMode: args.auto ? "auto" : undefined,
      })
    }
  }

  if (args.attach) {
    const sdk = createMerakCodeClient({ baseUrl: args.attach, directory, clientRun: Log.id() })
    return execute(sdk)
  }

  // The engine is a serve child process of this same binary (spawned through the SDK), shut down after this turn.
  await withEngine(execute)
}
