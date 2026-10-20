import {
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthMethod,
  type CancelNotification,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PermissionOption,
  type PlanEntry,
  type PromptRequest,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type Role,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type TerminalHandle,
  type ToolCallContent,
  type ToolKind,
  type Usage,
} from "@agentclientprotocol/sdk"

import { Log } from "@merakcode/log/logger"
import { pathToFileURL } from "node:url"
import { ACPSessionManager } from "./session"
import type { ACPConfig } from "./types"
import { z } from "zod"
import type {
  AssistantMessageOutput,
  Event,
  McpLocalConfig,
  McpRemoteConfig,
  MerakCodeClient,
  Provider,
  SessionMessageResponse,
  Todo,
} from "@merakcode/sdk/client"
import { applyPatch } from "diff"
import { Filesystem } from "@merakcode/util/filesystem"
import { parseModel, sortModels } from "@merakcode/util/model"
import { Text } from "@merakcode/util/text"
import { VERSION } from "../../product-version"
import { I18n } from "../i18n"

type ModeOption = { id: string; name: string; description?: string }

const DEFAULT_VARIANT_VALUE = "default"

/**
 * Language of text sent to the ACP client; same as other merak subcommands (MERAKCODE_LOCALE → global config locale →
 * Chinese).
 */
const language = (): Text.Lang => (I18n.current() === "en-US" ? "en" : "zh")
const pick = (text: Text.Pair, params?: Record<string, unknown>) => Text.format(text, language(), params)

/** Output of the todowrite tool: the todo list as JSON. */
const TodoList = z.array(
  z.object({ content: z.string(), status: z.string(), priority: z.string(), id: z.string() }),
) satisfies z.ZodType<Todo[]>

export namespace ACP {
  const log = Log.create({ service: "acp-agent" })

  async function getContextLimit(
    sdk: MerakCodeClient,
    providerID: string,
    modelID: string,
    directory: string,
  ): Promise<number | null> {
    const providers = await sdk.config
      .providers({ directory })
      .then((x) => x.data?.providers ?? [])
      .catch((error) => {
        log.error("failed to get providers for context limit", { error })
        return []
      })

    const provider = providers.find((p) => p.id === providerID)
    const model = provider?.models[modelID]
    return model?.limit.context ?? null
  }

  async function sendUsageUpdate(
    connection: AgentSideConnection,
    sdk: MerakCodeClient,
    sessionID: string,
    directory: string,
  ): Promise<void> {
    const messages = await sdk.session
      .messages({ sessionID, directory }, { throwOnError: true })
      .then((x) => x.data)
      .catch((error) => {
        log.error("failed to fetch messages for usage update", { error })
        return undefined
      })

    if (!messages) return

    const assistantMessages = messages.flatMap((m) => (m.info.role === "assistant" ? [{ ...m, info: m.info }] : []))

    const lastAssistant = assistantMessages[assistantMessages.length - 1]
    if (!lastAssistant) return

    const msg = lastAssistant.info
    const size = await getContextLimit(sdk, msg.providerID, msg.modelID, directory)

    if (!size) {
      // Cannot calculate usage without known context size
      return
    }

    const used = msg.tokens.input + (msg.tokens.cache?.read ?? 0)
    const totalCost = assistantMessages.reduce((sum, m) => sum + m.info.cost, 0)

    await connection
      .sessionUpdate({
        sessionId: sessionID,
        update: {
          sessionUpdate: "usage_update",
          used,
          size,
          cost: { amount: totalCost, currency: "USD" },
        },
      })
      .catch((error) => {
        log.error("failed to send usage update", { error })
      })
  }

  export class Agent implements ACPAgent {
    private connection: AgentSideConnection
    private config: ACPConfig
    private sdk: MerakCodeClient
    private sessionManager: ACPSessionManager
    private eventAbort = new AbortController()
    private eventStarted = false
    private permissionQueues = new Map<string, Promise<void>>()
    // PermissionNext.Reply only supports "once" | "reject", so ACP options only allow or reject the current request.
    // Labels are user-facing, so they are resolved in the UI language on every request.
    private async permissionOptions(): Promise<PermissionOption[]> {
      const lang = language()
      return [
        { optionId: "once", kind: "allow_once", name: Text.format({ zh: "允许一次", en: "Allow once" }, lang) },
        { optionId: "reject", kind: "reject_once", name: Text.format({ zh: "拒绝", en: "Reject" }, lang) },
      ]
    }
    private terminalMap = new Map<string, TerminalHandle>()
    private readonly extMethods: Record<string, (params: any) => Promise<any>> = {
      "merakcode/provider.list": () => this.handleProviderList(),
      "merakcode/provider.auth": (params) => this.handleProviderAuth(params),
    }

    constructor(connection: AgentSideConnection, config: ACPConfig) {
      this.connection = connection
      this.config = config
      this.sdk = config.sdk
      this.sessionManager = new ACPSessionManager(this.sdk)
      this.startEventSubscription()

      // Release all terminals when the connection closes. Registered in a microtask so the SDK finishes initializing.
      queueMicrotask(() => {
        try {
          this.connection.signal?.addEventListener("abort", () => {
            for (const [toolCallId, terminal] of this.terminalMap.entries()) {
              terminal.release().catch((error) => {
                log.error("failed to release terminal on abort", { toolCallId, error })
              })
            }
            this.terminalMap.clear()
          })
        } catch {
          // The signal may be unavailable, e.g. in tests.
        }
      })
    }

    private startEventSubscription() {
      if (this.eventStarted) return
      this.eventStarted = true
      this.runEventSubscription().catch((error) => {
        if (this.eventAbort.signal.aborted) return
        log.error("event subscription failed", { error })
      })
    }

    private async runEventSubscription() {
      while (true) {
        if (this.eventAbort.signal.aborted) return
        const events = await this.sdk.global.event({
          signal: this.eventAbort.signal,
        })
        for await (const event of events.stream) {
          if (this.eventAbort.signal.aborted) return
          const payload = (event as any)?.payload
          if (!payload) continue
          await this.handleEvent(payload as Event).catch((error) => {
            log.error("failed to handle event", { error, type: payload.type })
          })
        }
      }
    }

    private async handleEvent(event: Event) {
      switch (event.type) {
        case "permission.asked": {
          const permission = event.properties
          const session = this.sessionManager.tryGet(permission.sessionID)
          if (!session) return

          const prev = this.permissionQueues.get(permission.sessionID) ?? Promise.resolve()
          const next = prev
            .then(async () => {
              const directory = session.cwd

              const res = await this.connection
                .requestPermission({
                  sessionId: permission.sessionID,
                  toolCall: {
                    toolCallId: permission.tool?.callID ?? permission.id,
                    status: "pending",
                    title: permission.permission,
                    rawInput: permission.metadata,
                    kind: toToolKind(permission.permission),
                    locations: toLocations(permission.permission, permission.metadata),
                  },
                  options: await this.permissionOptions(),
                })
                .catch(async (error) => {
                  log.error("failed to request permission from ACP", {
                    error,
                    permissionID: permission.id,
                    sessionID: permission.sessionID,
                  })
                  await this.sdk.permission.reply({
                    requestID: permission.id,
                    reply: "reject",
                    directory,
                  })
                  return undefined
                })

              if (!res) return
              if (res.outcome.outcome !== "selected") {
                await this.sdk.permission.reply({
                  requestID: permission.id,
                  reply: "reject",
                  directory,
                })
                return
              }

              if (res.outcome.optionId !== "reject" && permission.permission == "edit") {
                const metadata = permission.metadata || {}
                const filepath = typeof metadata["filepath"] === "string" ? metadata["filepath"] : ""
                const diff = typeof metadata["diff"] === "string" ? metadata["diff"] : ""
                const file = filepath
                const content = (await Filesystem.isFile(file)) ? await Filesystem.readText(file) : ""
                const newContent = getNewContent(content, diff)

                if (newContent) {
                  this.connection.writeTextFile({
                    sessionId: session.id,
                    path: filepath,
                    content: newContent,
                  })
                }
              }

              await this.sdk.permission.reply({
                requestID: permission.id,
                reply: res.outcome.optionId as "once" | "reject",
                directory,
              })
            })
            .catch((error) => {
              log.error("failed to handle permission", { error, permissionID: permission.id })
            })
            .finally(() => {
              if (this.permissionQueues.get(permission.sessionID) === next) {
                this.permissionQueues.delete(permission.sessionID)
              }
            })
          this.permissionQueues.set(permission.sessionID, next)
          return
        }

        case "message.part.updated": {
          log.info("message part updated", { event: event.properties })
          const props = event.properties
          const part = props.part
          const session = this.sessionManager.tryGet(part.sessionID)
          if (!session) return
          const sessionId = session.id
          const directory = session.cwd

          const message = await this.sdk.session
            .message(
              {
                sessionID: part.sessionID,
                messageID: part.messageID,
                directory,
              },
              { throwOnError: true },
            )
            .then((x) => x.data)
            .catch((error) => {
              log.error("unexpected error when fetching message", { error })
              return undefined
            })

          if (!message || message.info.role !== "assistant") return

          if (part.type === "tool") {
            switch (part.state.status) {
              case "pending":
                await this.connection
                  .sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "tool_call",
                      toolCallId: part.callID,
                      title: part.tool,
                      kind: toToolKind(part.tool),
                      status: "pending",
                      locations: [],
                      rawInput: {},
                    },
                  })
                  .catch((error) => {
                    log.error("failed to send tool pending to ACP", { error })
                  })
                return

              case "running":
                // Create the terminal once per bash tool call.
                if (part.tool === "bash" && !this.terminalMap.has(part.callID)) {
                  const input = part.state.input || {}
                  const command = typeof input.command === "string" ? input.command : "bash"
                  const terminal = await this.connection.createTerminal({
                    sessionId,
                    command,
                  })
                  this.terminalMap.set(part.callID, terminal)
                  log.info("created terminal for tool", { toolCallId: part.callID, command })
                }

                await this.connection
                  .sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: part.callID,
                      status: "in_progress",
                      kind: toToolKind(part.tool),
                      title: part.tool,
                      locations: toLocations(part.tool, part.state.input),
                      rawInput: part.state.input,
                    },
                  })
                  .catch((error) => {
                    log.error("failed to send tool in_progress to ACP", { error })
                  })
                return

              case "completed": {
                const kind = toToolKind(part.tool)
                const content: ToolCallContent[] = [
                  {
                    type: "content",
                    content: {
                      type: "text",
                      text: part.state.output,
                    },
                  },
                ]

                if (kind === "edit") {
                  const input = part.state.input
                  const filePath = typeof input["filePath"] === "string" ? input["filePath"] : ""
                  const oldText = typeof input["oldString"] === "string" ? input["oldString"] : ""
                  const newText =
                    typeof input["newString"] === "string"
                      ? input["newString"]
                      : typeof input["content"] === "string"
                        ? input["content"]
                        : ""
                  content.push({
                    type: "diff",
                    path: filePath,
                    oldText,
                    newText,
                  })
                }

                if (part.tool === "todowrite") {
                  const parsedTodos = TodoList.safeParse(JSON.parse(part.state.output))
                  if (parsedTodos.success) {
                    await this.connection
                      .sessionUpdate({
                        sessionId,
                        update: {
                          sessionUpdate: "plan",
                          entries: parsedTodos.data.map((todo) => {
                            const status: PlanEntry["status"] =
                              todo.status === "cancelled" ? "completed" : (todo.status as PlanEntry["status"])
                            return {
                              priority: "medium",
                              status,
                              content: todo.content,
                            }
                          }),
                        },
                      })
                      .catch((error) => {
                        log.error("failed to send session update for todo", { error })
                      })
                  } else {
                    log.error("failed to parse todo output", { error: parsedTodos.error })
                  }
                }

                await this.connection
                  .sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: part.callID,
                      status: "completed",
                      kind,
                      content,
                      title: part.state.title,
                      rawInput: part.state.input,
                      rawOutput: {
                        output: part.state.output,
                        metadata: part.state.metadata,
                      },
                    },
                  })
                  .catch((error) => {
                    log.error("failed to send tool completed to ACP", { error })
                  })

                // Release the terminal once the tool completes.
                const terminal = this.terminalMap.get(part.callID)
                if (terminal) {
                  await terminal.release().catch((error) => {
                    log.error("failed to release terminal on tool completed", { toolCallId: part.callID, error })
                  })
                  this.terminalMap.delete(part.callID)
                  log.info("released terminal for tool", { toolCallId: part.callID })
                }
                return
              }
              case "error":
                await this.connection
                  .sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: part.callID,
                      status: "failed",
                      kind: toToolKind(part.tool),
                      title: part.tool,
                      rawInput: part.state.input,
                      content: [
                        {
                          type: "content",
                          content: {
                            type: "text",
                            text: part.state.error,
                          },
                        },
                      ],
                      rawOutput: {
                        error: part.state.error,
                      },
                    },
                  })
                  .catch((error) => {
                    log.error("failed to send tool error to ACP", { error })
                  })

                // Release the terminal when the tool fails.
                const terminalError = this.terminalMap.get(part.callID)
                if (terminalError) {
                  await terminalError.release().catch((error) => {
                    log.error("failed to release terminal on tool error", { toolCallId: part.callID, error })
                  })
                  this.terminalMap.delete(part.callID)
                  log.info("released terminal for tool", { toolCallId: part.callID })
                }
                return
            }
          }

          if (part.type === "text") {
            const delta = props.delta
            if (delta && part.ignored !== true) {
              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: delta,
                    },
                  },
                })
                .catch((error) => {
                  log.error("failed to send text to ACP", { error })
                })
            }
            return
          }

          if (part.type === "reasoning") {
            const delta = props.delta
            if (delta) {
              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "agent_thought_chunk",
                    content: {
                      type: "text",
                      text: delta,
                    },
                  },
                })
                .catch((error) => {
                  log.error("failed to send reasoning to ACP", { error })
                })
            }
          }
          return
        }

        case "session.updated": {
          const props = event.properties
          log.info("session updated", { sessionId: props.info.id })
          await this.connection
            .extNotification("session.updated", {
              sessionId: props.info.id,
            })
            .catch((error) => {
              log.error("failed to send session.updated extNotification", { error })
            })
          return
        }

        case "session.deleted": {
          const props = event.properties
          log.info("session deleted", { sessionId: props.info.id })
          this.sessionManager.remove(props.info.id)
          await this.connection
            .extNotification("session.deleted", {
              sessionId: props.info.id,
            })
            .catch((error) => {
              log.error("failed to send session.deleted extNotification", { error })
            })
          return
        }

        case "session.error": {
          const props = event.properties
          log.error("session error", { sessionId: props.sessionID, error: props.error })
          if (!props.sessionID) return
          const session = this.sessionManager.tryGet(props.sessionID)
          if (session) {
            // Session errors are reported to the client as an agent message chunk.
            await this.connection
              .sessionUpdate({
                sessionId: session.id,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: pick(
                      { zh: "会话错误: {error}", en: "Session error: {error}" },
                      { error: typeof props.error === "string" ? props.error : JSON.stringify(props.error) },
                    ),
                  },
                },
              })
              .catch((error) => {
                log.error("failed to send session error to ACP", { error })
              })
          }
          return
        }
      }
    }

    async initialize(params: InitializeRequest): Promise<InitializeResponse> {
      log.info("initialize", { protocolVersion: params.protocolVersion })

      const authMethod: AuthMethod = {
        description: pick({
          zh: "在终端运行 `merak provider login` 配置模型 Provider 凭据",
          en: "Run `merak provider login` in a terminal to set up model provider credentials",
        }),
        name: "Login with MerakCode",
        id: "merakcode-login",
      }

      // If client supports terminal-auth capability, use that instead.
      if (params.clientCapabilities?._meta?.["terminal-auth"] === true) {
        authMethod._meta = {
          "terminal-auth": {
            command: "merakcode",
            args: ["provider", "login"],
            label: "MerakCode Login",
          },
        }
      }

      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: {
            http: true,
            sse: true,
          },
          promptCapabilities: {
            embeddedContext: true,
            image: true,
          },
          sessionCapabilities: {
            fork: {},
            list: {},
            resume: {},
          },
        },
        authMethods: [authMethod],
        agentInfo: {
          name: "MerakCode",
          version: VERSION,
        },
      }
    }

    async authenticate(_params: AuthenticateRequest) {
      // Model credentials are set up beforehand with `provider login`; there is no extra login step here.
      return {}
    }

    async extNotification(_method: string, _params: any): Promise<void> {
      // Intentionally empty; required by the ACP protocol.
    }

    async extMethod(method: string, params: any): Promise<any> {
      log.info("extMethod", { method })
      const handler = this.extMethods[method]
      if (!handler) throw RequestError.invalidParams(JSON.stringify({ error: `Unknown extMethod: ${method}` }))
      return handler(params)
    }

    private async handleProviderList(): Promise<any> {
      const result = await this.sdk.provider.list()
      return result.data
    }

    private async handleProviderAuth(params: any): Promise<any> {
      const result = await this.sdk.provider.auth(params)
      return result.data
    }

    private async handleBuiltinCommand(
      cmd: { name: string; args: string },
      sessionId: string,
      directory: string,
      model: { providerID: string; modelID: string },
    ): Promise<boolean> {
      switch (cmd.name) {
        case "compact":
        case "summarize":
          await this.config.sdk.session.summarize(
            {
              sessionID: sessionId,
              directory,
              providerID: model.providerID,
              modelID: model.modelID,
            },
            { throwOnError: true },
          )
          return true

        case "rename":
          if (!cmd.args) {
            await this.connection.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: pick({ zh: "请提供新的会话名称", en: "Please provide a new session name" }),
                },
              },
            })
            return true
          }
          await this.config.sdk.session.update(
            {
              sessionID: sessionId,
              directory,
              title: cmd.args,
            },
            { throwOnError: true },
          )
          return true

        case "undo": {
          // Revert to before the latest message the user typed; if already reverted, search back from the revert point
          // (same as undo in the TUI).
          const [messages, info] = await Promise.all([
            this.config.sdk.session
              .messages({ sessionID: sessionId, directory }, { throwOnError: true })
              .then((x) => x.data ?? []),
            this.config.sdk.session
              .get({ sessionID: sessionId, directory }, { throwOnError: true })
              .then((x) => x.data),
          ])
          const end = messages.findIndex((m) => m.info.id === info?.revert?.messageID)
          const target = messages
            .slice(0, end === -1 ? undefined : end)
            .findLast(
              (m) =>
                m.info.role === "user" &&
                m.parts.some((p) => p.type === "text" && !p.synthetic && !p.ignored && p.text.trim()),
            )
          if (!target) {
            await this.connection.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: pick({ zh: "没有可撤销的消息", en: "Nothing to undo" }) },
              },
            })
            return true
          }
          await this.config.sdk.session.revert(
            { sessionID: sessionId, directory, messageID: target.info.id },
            { throwOnError: true },
          )
          return true
        }

        case "redo":
          await this.config.sdk.session.unrevert(
            {
              sessionID: sessionId,
              directory,
            },
            { throwOnError: true },
          )
          return true

        case "export":
        case "copy": {
          const messages = await this.config.sdk.session
            .messages(
              {
                sessionID: sessionId,
                directory,
              },
              { throwOnError: true },
            )
            .then((x) => x.data ?? [])

          const sessionInfo = await this.config.sdk.session
            .get(
              {
                sessionID: sessionId,
                directory,
              },
              { throwOnError: true },
            )
            .then((x) => x.data!)

          const { formatTranscript } = await import("@merakcode/sdk/transcript")
          const content = formatTranscript(
            {
              id: sessionInfo.id,
              title: sessionInfo.title,
              time: sessionInfo.time,
            },
            messages.map((m) => ({ info: m.info, parts: m.parts })),
            {
              thinking: false,
              toolDetails: false,
              assistantMetadata: false,
              lang: language(),
            },
          )

          await this.connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: content,
              },
            },
          })
          return true
        }

        default:
          return false
      }
    }

    async newSession(params: NewSessionRequest) {
      const directory = params.cwd
      // Reload auth state; the user may have logged in from the CLI after ACP started.
      await this.sdk.instance.dispose().catch(() => {})

      const model = await defaultModel(this.config, directory)

      // Store ACP session state
      const state = await this.sessionManager.create(params.cwd, params.mcpServers, model)
      const sessionId = state.id

      log.info("creating_session", { sessionId, mcpServers: params.mcpServers.length })

      const load = await this.loadSessionMode({
        cwd: directory,
        mcpServers: params.mcpServers,
        sessionId,
      })

      return {
        sessionId,
        configOptions: load.configOptions,
        modes: load.modes,
      }
    }

    async loadSession(params: LoadSessionRequest) {
      const directory = params.cwd
      const sessionId = params.sessionId

      // Reload auth state; the user may have logged in from the CLI after ACP started.
      await this.sdk.instance.dispose().catch(() => {})

      const model = await defaultModel(this.config, directory)

      // Store ACP session state
      await this.sessionManager.load(sessionId, params.cwd, params.mcpServers, model)

      log.info("load_session", { sessionId, mcpServers: params.mcpServers.length })

      // Replay session history
      const messages = await this.sdk.session
        .messages(
          {
            sessionID: sessionId,
            directory,
          },
          { throwOnError: true },
        )
        .then((x) => x.data)
        .catch((err) => {
          log.error("unexpected error when fetching message", { error: err })
          return undefined
        })

      // Continue with the previous turn's model, variant and mode (loadSessionMode falls back to the default if the
      // mode no longer exists).
      const lastUser = messages?.findLast((m) => m.info.role === "user")?.info
      if (lastUser?.role === "user") {
        this.sessionManager.setModel(sessionId, {
          providerID: lastUser.model.providerID,
          modelID: lastUser.model.modelID,
        })
        this.sessionManager.setVariant(sessionId, lastUser.variant)
        this.sessionManager.setMode(sessionId, lastUser.agent)
      }

      const result = await this.loadSessionMode({
        cwd: directory,
        mcpServers: params.mcpServers,
        sessionId,
      })

      for (const msg of messages ?? []) {
        log.debug("replay message", msg)
        await this.processMessage(msg)
      }

      await sendUsageUpdate(this.connection, this.sdk, sessionId, directory)

      return result
    }

    async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
      const cursor = params.cursor ? Number(params.cursor) : undefined
      const limit = 100

      const sessions = await this.sdk.session
        .list(
          {
            directory: params.cwd ?? undefined,
            roots: true,
          },
          { throwOnError: true },
        )
        .then((x) => x.data ?? [])

      const sorted = sessions.toSorted((a, b) => b.time.updated - a.time.updated)
      const filtered = cursor ? sorted.filter((s) => s.time.updated < cursor) : sorted
      const page = filtered.slice(0, limit)

      const entries: SessionInfo[] = page.map((session) => ({
        sessionId: session.id,
        cwd: session.directory,
        title: session.title,
        updatedAt: new Date(session.time.updated).toISOString(),
      }))

      const last = page[page.length - 1]
      const next = filtered.length > limit && last ? String(last.time.updated) : undefined

      const response: ListSessionsResponse = {
        sessions: entries,
      }
      if (next) response.nextCursor = next
      return response
    }

    async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
      const directory = params.cwd
      const mcpServers = params.mcpServers ?? []

      const model = await defaultModel(this.config, directory)

      const forked = await this.sdk.session
        .fork(
          {
            sessionID: params.sessionId,
            directory,
          },
          { throwOnError: true },
        )
        .then((x) => x.data)

      if (!forked) {
        throw new Error("Fork session returned no data")
      }

      const sessionId = forked.id
      await this.sessionManager.load(sessionId, directory, mcpServers, model)

      log.info("fork_session", { sessionId, mcpServers: mcpServers.length })

      const mode = await this.loadSessionMode({
        cwd: directory,
        mcpServers,
        sessionId,
      })

      const messages = await this.sdk.session
        .messages(
          {
            sessionID: sessionId,
            directory,
          },
          { throwOnError: true },
        )
        .then((x) => x.data)
        .catch((err) => {
          log.error("unexpected error when fetching message", { error: err })
          return undefined
        })

      for (const msg of messages ?? []) {
        log.debug("replay message", msg)
        await this.processMessage(msg)
      }

      await sendUsageUpdate(this.connection, this.sdk, sessionId, directory)

      return mode
    }

    async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
      const directory = params.cwd
      const sessionId = params.sessionId
      const mcpServers = params.mcpServers ?? []

      const model = await defaultModel(this.config, directory)
      await this.sessionManager.load(sessionId, directory, mcpServers, model)

      log.info("resume_session", { sessionId, mcpServers: mcpServers.length })

      const result = await this.loadSessionMode({
        cwd: directory,
        mcpServers,
        sessionId,
      })

      await sendUsageUpdate(this.connection, this.sdk, sessionId, directory)

      return result
    }

    private async processMessage(message: SessionMessageResponse) {
      log.debug("process message", message)
      if (message.info.role !== "assistant" && message.info.role !== "user") return
      const sessionId = message.info.sessionID

      for (const part of message.parts) {
        if (part.type === "tool") {
          switch (part.state.status) {
            case "pending":
              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: part.callID,
                    title: part.tool,
                    kind: toToolKind(part.tool),
                    status: "pending",
                    locations: [],
                    rawInput: {},
                  },
                })
                .catch((err) => {
                  log.error("failed to send tool pending to ACP", { error: err })
                })
              break
            case "running":
              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: part.callID,
                    status: "in_progress",
                    kind: toToolKind(part.tool),
                    title: part.tool,
                    locations: toLocations(part.tool, part.state.input),
                    rawInput: part.state.input,
                  },
                })
                .catch((err) => {
                  log.error("failed to send tool in_progress to ACP", { error: err })
                })
              break
            case "completed":
              const kind = toToolKind(part.tool)
              const content: ToolCallContent[] = [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: part.state.output,
                  },
                },
              ]

              if (kind === "edit") {
                const input = part.state.input
                const filePath = typeof input["filePath"] === "string" ? input["filePath"] : ""
                const oldText = typeof input["oldString"] === "string" ? input["oldString"] : ""
                const newText =
                  typeof input["newString"] === "string"
                    ? input["newString"]
                    : typeof input["content"] === "string"
                      ? input["content"]
                      : ""
                content.push({
                  type: "diff",
                  path: filePath,
                  oldText,
                  newText,
                })
              }

              if (part.tool === "todowrite") {
                const parsedTodos = TodoList.safeParse(JSON.parse(part.state.output))
                if (parsedTodos.success) {
                  await this.connection
                    .sessionUpdate({
                      sessionId,
                      update: {
                        sessionUpdate: "plan",
                        entries: parsedTodos.data.map((todo) => {
                          const status: PlanEntry["status"] =
                            todo.status === "cancelled" ? "completed" : (todo.status as PlanEntry["status"])
                          return {
                            priority: "medium",
                            status,
                            content: todo.content,
                          }
                        }),
                      },
                    })
                    .catch((err) => {
                      log.error("failed to send session update for todo", { error: err })
                    })
                } else {
                  log.error("failed to parse todo output", { error: parsedTodos.error })
                }
              }

              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: part.callID,
                    status: "completed",
                    kind,
                    content,
                    title: part.state.title,
                    rawInput: part.state.input,
                    rawOutput: {
                      output: part.state.output,
                      metadata: part.state.metadata,
                    },
                  },
                })
                .catch((err) => {
                  log.error("failed to send tool completed to ACP", { error: err })
                })
              break
            case "error":
              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: part.callID,
                    status: "failed",
                    kind: toToolKind(part.tool),
                    title: part.tool,
                    rawInput: part.state.input,
                    content: [
                      {
                        type: "content",
                        content: {
                          type: "text",
                          text: part.state.error,
                        },
                      },
                    ],
                    rawOutput: {
                      error: part.state.error,
                    },
                  },
                })
                .catch((err) => {
                  log.error("failed to send tool error to ACP", { error: err })
                })
              break
          }
        } else if (part.type === "text") {
          if (part.text) {
            const audience: Role[] | undefined = part.synthetic ? ["assistant"] : part.ignored ? ["user"] : undefined
            await this.connection
              .sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: message.info.role === "user" ? "user_message_chunk" : "agent_message_chunk",
                  content: {
                    type: "text",
                    text: part.text,
                    ...(audience && { annotations: { audience } }),
                  },
                },
              })
              .catch((err) => {
                log.error("failed to send text to ACP", { error: err })
              })
          }
        } else if (part.type === "file") {
          // Replay file attachments as appropriate ACP content blocks.
          // MerakCode stores files internally as { type: "file", url, filename, mime }.
          // We convert these back to ACP blocks based on the URL scheme and MIME type:
          // - file:// URLs → resource_link
          // - data: URLs with image/* → image block
          // - data: URLs with text/* or application/json → resource with text
          // - data: URLs with other types → resource with blob
          const url = part.url
          const filename = part.filename ?? "file"
          const mime = part.mime || "application/octet-stream"
          const messageChunk = message.info.role === "user" ? "user_message_chunk" : "agent_message_chunk"

          if (url.startsWith("file://")) {
            // Local file reference - send as resource_link
            await this.connection
              .sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: messageChunk,
                  content: { type: "resource_link", uri: url, name: filename, mimeType: mime },
                },
              })
              .catch((err) => {
                log.error("failed to send resource_link to ACP", { error: err })
              })
          } else if (url.startsWith("data:")) {
            // Embedded content - parse data URL and send as appropriate block type
            const base64Match = url.match(/^data:([^;]+);base64,(.*)$/)
            const dataMime = base64Match?.[1]
            const base64Data = base64Match?.[2] ?? ""

            const effectiveMime = dataMime || mime

            if (effectiveMime.startsWith("image/")) {
              // Image - send as image block
              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: messageChunk,
                    content: {
                      type: "image",
                      mimeType: effectiveMime,
                      data: base64Data,
                      uri: pathToFileURL(filename).href,
                    },
                  },
                })
                .catch((err) => {
                  log.error("failed to send image to ACP", { error: err })
                })
            } else {
              // Non-image: text types get decoded, binary types stay as blob
              const isText = effectiveMime.startsWith("text/") || effectiveMime === "application/json"
              const fileUri = pathToFileURL(filename).href
              const resource = isText
                ? {
                    uri: fileUri,
                    mimeType: effectiveMime,
                    text: Buffer.from(base64Data, "base64").toString("utf-8"),
                  }
                : { uri: fileUri, mimeType: effectiveMime, blob: base64Data }

              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: messageChunk,
                    content: { type: "resource", resource },
                  },
                })
                .catch((err) => {
                  log.error("failed to send resource to ACP", { error: err })
                })
            }
          }
          // URLs that don't match file:// or data: are skipped (unsupported)
        } else if (part.type === "reasoning") {
          if (part.text) {
            await this.connection
              .sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: "agent_thought_chunk",
                  content: {
                    type: "text",
                    text: part.text,
                  },
                },
              })
              .catch((err) => {
                log.error("failed to send reasoning to ACP", { error: err })
              })
          }
        }
      }
    }

    private async loadAvailableModes(directory: string): Promise<ModeOption[]> {
      const agents = await this.config.sdk.app
        .agents(
          {
            directory,
          },
          { throwOnError: true },
        )
        .then((resp) => resp.data!)

      return agents
        .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          description: agent.description,
        }))
    }

    private async resolveModeState(
      directory: string,
      sessionId: string,
    ): Promise<{ availableModes: ModeOption[]; currentModeId?: string }> {
      const availableModes = await this.loadAvailableModes(directory)
      const saved = this.sessionManager.get(sessionId).modeId
      const currentModeId =
        availableModes.find((mode) => mode.id === saved)?.id ??
        (await (async () => {
          // The engine lists the default agent first (configured default_agent, otherwise build).
          const resolvedModeId = availableModes[0]?.id
          if (!resolvedModeId) return undefined
          this.sessionManager.setMode(sessionId, resolvedModeId)
          return resolvedModeId
        })())

      return { availableModes, currentModeId }
    }

    /**
     * Session config options: mode and model (reasoning variants are merged into the model options as
     * "provider/model/variant"). Modes are still sent so clients without config option support can switch modes.
     */
    private async sessionConfig(sessionId: string) {
      const session = this.sessionManager.get(sessionId)
      const directory = session.cwd
      const model = session.model ?? (await defaultModel(this.config, directory))
      const providers = await this.sdk.config
        .providers({ directory }, { throwOnError: true })
        .then((x) => sortProvidersByName(x.data!.providers))
      const variants = modelVariantsFromProviders(providers, model)
      const variant = this.sessionManager.getVariant(sessionId)
      if (variant && !variants.includes(variant)) this.sessionManager.setVariant(sessionId, undefined)
      const { availableModes, currentModeId } = await this.resolveModeState(directory, sessionId)
      const lang = language()
      const mode: SessionConfigOption[] = currentModeId
        ? [
            {
              id: "mode",
              name: Text.format({ zh: "模式", en: "Mode" }, lang),
              category: "mode",
              type: "select",
              currentValue: currentModeId,
              options: availableModes.map((item) => ({
                value: item.id,
                name: item.name,
                description: item.description,
              })),
            },
          ]
        : []
      const configOptions: SessionConfigOption[] = [
        ...mode,
        {
          id: "model",
          name: Text.format({ zh: "模型", en: "Model" }, lang),
          category: "model",
          type: "select",
          currentValue: formatModelIdWithVariant(model, this.sessionManager.getVariant(sessionId), variants),
          options: buildAvailableModels(providers),
        },
      ]
      return { configOptions, modes: currentModeId ? { availableModes, currentModeId } : undefined }
    }

    private async loadSessionMode(params: LoadSessionRequest) {
      const directory = params.cwd
      const sessionId = params.sessionId
      const { configOptions, modes } = await this.sessionConfig(sessionId)

      const commands = await this.config.sdk.command
        .list(
          {
            directory,
          },
          { throwOnError: true },
        )
        .then((resp) => resp.data!)

      const availableCommands = commands.map((command) => ({
        name: command.name,
        description: command.description ?? "",
      }))
      const names = new Set(availableCommands.map((c) => c.name))

      // Built-in slash commands; descriptions are shown in the client's command list.
      const lang = language()
      const builtinCommands = [
        { name: "compact", description: { zh: "压缩会话历史", en: "Compact the session history" } },
        { name: "summarize", description: { zh: "总结会话", en: "Summarize the session" } },
        { name: "rename", description: { zh: "重命名会话", en: "Rename the session" } },
        { name: "undo", description: { zh: "撤销上一步", en: "Undo the last step" } },
        { name: "redo", description: { zh: "重做上一步", en: "Redo the last step" } },
        { name: "export", description: { zh: "导出会话", en: "Export the session" } },
        { name: "copy", description: { zh: "复制会话", en: "Copy the session" } },
        { name: "safe", description: { zh: "查看/设置安全级别", en: "View or set the safety level" } },
      ].map((cmd) => ({ name: cmd.name, description: Text.format(cmd.description, lang) }))

      for (const cmd of builtinCommands) {
        if (!names.has(cmd.name)) {
          availableCommands.push(cmd)
          names.add(cmd.name)
        }
      }

      const mcpServers: Record<string, McpLocalConfig | McpRemoteConfig> = {}
      for (const server of params.mcpServers) {
        // MCP over ACP is not advertised (mcpCapabilities.acp), so clients should not send it; it is unsupported.
        if ("type" in server && server.type === "acp") {
          log.warn("skip acp-transport mcp server", { name: server.name })
          continue
        }
        if ("type" in server) {
          mcpServers[server.name] = {
            url: server.url,
            headers: server.headers.reduce<Record<string, string>>((acc, { name, value }) => {
              acc[name] = value
              return acc
            }, {}),
            type: "remote",
          }
        } else {
          mcpServers[server.name] = {
            type: "local",
            command: [server.command, ...server.args],
            environment: server.env.reduce<Record<string, string>>((acc, { name, value }) => {
              acc[name] = value
              return acc
            }, {}),
          }
        }
      }

      await Promise.all(
        Object.entries(mcpServers).map(async ([key, mcp]) => {
          await this.sdk.mcp
            .add(
              {
                directory,
                name: key,
                config: mcp,
              },
              { throwOnError: true },
            )
            .catch((error) => {
              log.error("failed to add mcp server", { name: key, error })
            })
        }),
      )

      setTimeout(() => {
        this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands,
          },
        })
      }, 0)

      return { sessionId, configOptions, modes }
    }

    async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
      const session = this.sessionManager.get(params.sessionId)
      if (typeof params.value !== "string" || !["mode", "model"].includes(params.configId))
        throw RequestError.invalidParams({ configId: params.configId }, `Unknown config option: ${params.configId}`)
      if (params.configId === "mode") await this.setSessionMode({ sessionId: session.id, modeId: params.value })
      if (params.configId === "model") {
        const providers = await this.sdk.config
          .providers({ directory: session.cwd }, { throwOnError: true })
          .then((x) => x.data!.providers)
        const selection = parseModelSelection(params.value, providers)
        if (!providers.find((p) => p.id === selection.model.providerID)?.models[selection.model.modelID])
          throw RequestError.invalidParams({ value: params.value }, `Model not found: ${params.value}`)
        this.sessionManager.setModel(session.id, selection.model)
        this.sessionManager.setVariant(session.id, selection.variant)
      }
      return { configOptions: (await this.sessionConfig(session.id)).configOptions }
    }

    async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
      const session = this.sessionManager.get(params.sessionId)
      const availableModes = await this.loadAvailableModes(session.cwd)
      if (!availableModes.some((mode) => mode.id === params.modeId)) {
        throw new Error(`Agent not found: ${params.modeId}`)
      }
      this.sessionManager.setMode(params.sessionId, params.modeId)
    }

    async prompt(params: PromptRequest) {
      const sessionID = params.sessionId
      const session = this.sessionManager.get(sessionID)
      const directory = session.cwd

      const current = session.model
      const model = current ?? (await defaultModel(this.config, directory))
      if (!current) {
        this.sessionManager.setModel(session.id, model)
      }
      // Left undefined when no mode was chosen, so the engine uses the default agent.
      const agent = session.modeId

      const parts: Array<
        | { type: "text"; text: string; synthetic?: boolean; ignored?: boolean }
        | { type: "file"; url: string; filename: string; mime: string }
      > = []
      for (const part of params.prompt) {
        switch (part.type) {
          case "text":
            const audience = part.annotations?.audience
            const forAssistant = audience?.length === 1 && audience[0] === "assistant"
            const forUser = audience?.length === 1 && audience[0] === "user"
            parts.push({
              type: "text" as const,
              text: part.text,
              ...(forAssistant && { synthetic: true }),
              ...(forUser && { ignored: true }),
            })
            break
          case "image": {
            const parsed = parseUri(part.uri ?? "")
            const filename = parsed.type === "file" ? parsed.filename : "image"
            if (part.data) {
              parts.push({
                type: "file",
                url: `data:${part.mimeType};base64,${part.data}`,
                filename,
                mime: part.mimeType,
              })
            } else if (part.uri && part.uri.startsWith("http:")) {
              parts.push({
                type: "file",
                url: part.uri,
                filename,
                mime: part.mimeType,
              })
            }
            break
          }

          case "resource_link":
            const parsed = parseUri(part.uri)
            // Use the name from resource_link if available
            if (part.name && parsed.type === "file") {
              parsed.filename = part.name
            }
            parts.push(parsed)

            break

          case "resource": {
            const resource = part.resource
            if ("text" in resource && resource.text) {
              parts.push({
                type: "text",
                text: resource.text,
              })
            } else if ("blob" in resource && resource.blob && resource.mimeType) {
              // Binary resource (PDFs, etc.): store as file part with data URL
              const parsed = parseUri(resource.uri ?? "")
              const filename = parsed.type === "file" ? parsed.filename : "file"
              parts.push({
                type: "file",
                url: `data:${resource.mimeType};base64,${resource.blob}`,
                filename,
                mime: resource.mimeType,
              })
            }
            break
          }

          default:
            break
        }
      }

      log.info("parts", { parts })

      const cmd = (() => {
        const text = parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("")
          .trim()

        if (!text.startsWith("/")) return

        const [name, ...rest] = text.slice(1).split(/\s+/)
        return { name, args: rest.join(" ").trim() }
      })()

      const buildUsage = (msg: AssistantMessageOutput): Usage => ({
        totalTokens:
          msg.tokens.input +
          msg.tokens.output +
          msg.tokens.reasoning +
          (msg.tokens.cache?.read ?? 0) +
          (msg.tokens.cache?.write ?? 0),
        inputTokens: msg.tokens.input,
        outputTokens: msg.tokens.output,
        thoughtTokens: msg.tokens.reasoning || undefined,
        cachedReadTokens: msg.tokens.cache?.read || undefined,
        cachedWriteTokens: msg.tokens.cache?.write || undefined,
      })

      if (!cmd) {
        const response = await this.sdk.session.prompt({
          sessionID,
          model: {
            providerID: model.providerID,
            modelID: model.modelID,
          },
          variant: this.sessionManager.getVariant(sessionID),
          parts,
          agent,
          directory,
        })
        const msg = response.data?.info

        await sendUsageUpdate(this.connection, this.sdk, sessionID, directory)

        return {
          stopReason: "end_turn" as const,
          usage: msg ? buildUsage(msg) : undefined,
          _meta: {},
        }
      }

      // Built-in commands take precedence over server commands.
      const handled = await this.handleBuiltinCommand(cmd, sessionID, directory, model)
      if (handled) {
        await sendUsageUpdate(this.connection, this.sdk, sessionID, directory)
        return {
          stopReason: "end_turn" as const,
          _meta: {},
        }
      }

      const command = await this.config.sdk.command
        .list({ directory }, { throwOnError: true })
        .then((x) => x.data!.find((c) => c.name === cmd.name))
      if (command) {
        const response = await this.sdk.session.command({
          sessionID,
          command: command.name,
          arguments: cmd.args,
          model: model.providerID + "/" + model.modelID,
          agent,
          directory,
        })
        const msg = response.data?.info

        await sendUsageUpdate(this.connection, this.sdk, sessionID, directory)

        return {
          stopReason: "end_turn" as const,
          usage: msg ? buildUsage(msg) : undefined,
          _meta: {},
        }
      }

      await this.connection.sessionUpdate({
        sessionId: sessionID,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: pick({ zh: "未知命令: /{name}", en: "Unknown command: /{name}" }, { name: cmd.name }),
          },
        },
      })

      await sendUsageUpdate(this.connection, this.sdk, sessionID, directory)

      return {
        stopReason: "end_turn" as const,
        _meta: {},
      }
    }

    async cancel(params: CancelNotification) {
      const session = this.sessionManager.get(params.sessionId)
      await this.config.sdk.session.abort(
        {
          sessionID: params.sessionId,
          directory: session.cwd,
        },
        { throwOnError: true },
      )
    }
  }

  function toToolKind(toolName: string): ToolKind {
    const tool = toolName.toLocaleLowerCase()
    switch (tool) {
      case "bash":
        return "execute"
      case "webfetch":
        return "fetch"

      case "edit":
      case "patch":
      case "write":
        return "edit"

      case "grep":
      case "glob":
      case "context7_resolve_library_id":
      case "context7_get_library_docs":
        return "search"

      case "ls":
      case "read":
        return "read"

      default:
        return "other"
    }
  }

  function toLocations(toolName: string, input: Record<string, any>): { path: string }[] {
    const tool = toolName.toLocaleLowerCase()
    switch (tool) {
      case "read":
      case "edit":
      case "write":
        return input["filePath"] ? [{ path: input["filePath"] }] : []
      case "glob":
      case "grep":
        return input["path"] ? [{ path: input["path"] }] : []
      case "bash":
        return []
      case "ls":
        return input["path"] ? [{ path: input["path"] }] : []
      default:
        return []
    }
  }

  async function defaultModel(config: ACPConfig, cwd?: string) {
    const sdk = config.sdk
    const configured = config.defaultModel
    if (configured) return configured

    const directory = cwd ?? process.cwd()

    const specified = await sdk.config
      .get({ directory }, { throwOnError: true })
      .then((resp) => {
        const cfg = resp.data
        if (!cfg || !cfg.model) return undefined
        const parsed = parseModel(cfg.model)
        return {
          providerID: parsed.providerID,
          modelID: parsed.modelID,
        }
      })
      .catch((error) => {
        log.error("failed to load user config for default model", { error })
        return undefined
      })

    // Connected providers (in the order the engine picks default models) and each provider's default model.
    const listed = await sdk.provider
      .list({ directory }, { throwOnError: true })
      .then((x) => x.data)
      .catch((error) => {
        log.error("failed to list providers for default model", { error })
        return undefined
      })
    const connected = listed?.connected ?? []

    if (specified && connected.length) {
      const provider = listed!.all.find((p) => p.id === specified.providerID)
      if (connected.includes(specified.providerID) && provider?.models[specified.modelID]) return specified
    }

    if (specified && !connected.length) return specified

    // Like the engine: use the default model of the first connected provider. Models are not pooled across providers:
    // one key can connect several providers (e.g. regional endpoints of the same vendor), and pooling could pick a
    // provider the key does not work with.
    const first = connected.find((id) => listed!.default[id])
    if (first) return { providerID: first, modelID: listed!.default[first]! }

    if (specified) return specified

    // No model available: downstream reports "model not found", prompting the user to configure a provider.
    return { providerID: "", modelID: "" }
  }

  function parseUri(
    uri: string,
  ): { type: "file"; url: string; filename: string; mime: string } | { type: "text"; text: string } {
    try {
      if (uri.startsWith("file://")) {
        const path = uri.slice(7)
        const name = path.split("/").pop() || path
        return {
          type: "file",
          url: uri,
          filename: name,
          mime: "text/plain",
        }
      }
      if (uri.startsWith("zed://")) {
        const url = new URL(uri)
        const path = url.searchParams.get("path")
        if (path) {
          const name = path.split("/").pop() || path
          return {
            type: "file",
            url: pathToFileURL(path).href,
            filename: name,
            mime: "text/plain",
          }
        }
      }
      return {
        type: "text",
        text: uri,
      }
    } catch {
      return {
        type: "text",
        text: uri,
      }
    }
  }

  function getNewContent(fileOriginal: string, unifiedDiff: string): string | undefined {
    const result = applyPatch(fileOriginal, unifiedDiff)
    if (result === false) {
      log.error("Failed to apply unified diff (context mismatch)")
      return undefined
    }
    return result
  }

  function sortProvidersByName<T extends { name: string }>(providers: T[]): T[] {
    return [...providers].sort((a, b) => {
      const nameA = a.name.toLowerCase()
      const nameB = b.name.toLowerCase()
      if (nameA < nameB) return -1
      if (nameA > nameB) return 1
      return 0
    })
  }

  function modelVariantsFromProviders(
    providers: Array<{ id: string; models: Record<string, { variants?: Record<string, any> }> }>,
    model: { providerID: string; modelID: string },
  ): string[] {
    const provider = providers.find((entry) => entry.id === model.providerID)
    if (!provider) return []
    const modelInfo = provider.models[model.modelID]
    if (!modelInfo?.variants) return []
    return Object.keys(modelInfo.variants)
  }

  function buildAvailableModels(providers: Pick<Provider, "id" | "name" | "models">[]): SessionConfigSelectOption[] {
    return providers.flatMap((provider) =>
      sortModels(Object.values(provider.models)).flatMap((model) => [
        { value: `${provider.id}/${model.id}`, name: `${provider.name}/${model.name}` },
        ...Object.keys(model.variants ?? {})
          .filter((variant) => variant !== DEFAULT_VARIANT_VALUE)
          .map((variant) => ({
            value: `${provider.id}/${model.id}/${variant}`,
            name: `${provider.name}/${model.name} (${variant})`,
          })),
      ]),
    )
  }

  function formatModelIdWithVariant(
    model: { providerID: string; modelID: string },
    variant: string | undefined,
    availableVariants: string[],
  ) {
    const base = `${model.providerID}/${model.modelID}`
    if (!variant || !availableVariants.includes(variant)) return base
    return `${base}/${variant}`
  }

  function parseModelSelection(
    modelId: string,
    providers: Array<{ id: string; models: Record<string, { variants?: Record<string, any> }> }>,
  ): { model: { providerID: string; modelID: string }; variant?: string } {
    const parsed = parseModel(modelId)
    const provider = providers.find((p) => p.id === parsed.providerID)
    if (!provider) {
      return { model: parsed, variant: undefined }
    }

    // Check if modelID exists directly
    if (provider.models[parsed.modelID]) {
      return { model: parsed, variant: undefined }
    }

    // Try to extract variant from end of modelID (e.g., "claude-sonnet-4/high" -> model: "claude-sonnet-4", variant: "high")
    const segments = parsed.modelID.split("/")
    if (segments.length > 1) {
      const candidateVariant = segments[segments.length - 1]
      const baseModelId = segments.slice(0, -1).join("/")
      const baseModelInfo = provider.models[baseModelId]
      if (baseModelInfo?.variants && candidateVariant in baseModelInfo.variants) {
        return {
          model: { providerID: parsed.providerID, modelID: baseModelId },
          variant: candidateVariant,
        }
      }
    }

    return { model: parsed, variant: undefined }
  }
}
