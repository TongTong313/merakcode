import { AsyncLocalStorage } from "node:async_hooks"
import { dynamicTool, type Tool, jsonSchema, type JSONSchema7 } from "ai"
import { Network } from "@merakcode/util/network"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  CallToolResultSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { Config } from "@merakcode/engine/agent/settings/index"
import { Log } from "@merakcode/log/logger"
import { NamedError } from "@merakcode/util/error"
import z from "zod/v4"
import { Instance } from "../../infra/project/instance"
import { Installation } from "../../infra/installation"
import { withTimeout } from "../../infra/concurrency/timeout"
import { BusEvent } from "../../infra/bus/bus-event"
import { Bus } from "../../infra/bus"
import { failure } from "@merakcode/log"
import { Text } from "../prompt/text"
import {
  begin as beginOAuthFlow,
  exchange as exchangeOAuth,
  McpServerNotFoundError,
  McpUnsupportedOAuthError,
  oauthOptions,
  remove as removeOAuth,
  transportProvider,
  waitForBrowserCode,
} from "./oauth"

export namespace MCP {
  const log = Log.create({ service: "mcp" })
  const DEFAULT_TIMEOUT = 30_000

  export const Resource = z
    .object({
      name: z.string(),
      uri: z.string(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
      client: z.string(),
    })
    .meta({ ref: "McpResource" })
  export type Resource = z.infer<typeof Resource>

  export const ToolsChanged = BusEvent.define(
    "mcp.tools.changed",
    z.object({
      server: z.string(),
    }),
  )

  export const Failed = NamedError.create(
    "MCPFailed",
    z.object({
      name: z.string(),
    }),
  )

  type MCPClient = Client

  export const Scope = z.enum(["project", "global"]).meta({ ref: "McpScope" })
  export type Scope = z.infer<typeof Scope>

  export const Status = z
    .discriminatedUnion("status", [
      z
        .object({
          status: z.literal("connected"),
          scope: Scope.optional(),
        })
        .meta({
          ref: "MCPStatusConnected",
        }),
      z
        .object({
          status: z.literal("disabled"),
          scope: Scope.optional(),
        })
        .meta({
          ref: "MCPStatusDisabled",
        }),
      z
        .object({
          status: z.literal("failed"),
          error: z.string(),
          scope: Scope.optional(),
        })
        .meta({
          ref: "MCPStatusFailed",
        }),
      z
        .object({
          status: z.literal("needs_auth"),
          scope: Scope.optional(),
        })
        .meta({
          ref: "MCPStatusNeedsAuth",
        }),
      z
        .object({
          status: z.literal("needs_client_registration"),
          error: z.string(),
          scope: Scope.optional(),
        })
        .meta({
          ref: "MCPStatusNeedsClientRegistration",
        }),
    ])
    .meta({
      ref: "MCPStatus",
    })
  export type Status = z.infer<typeof Status>

  /**
   * tool-list-changed notification counter per server name.
   *
   * The notification handler must not call state(): it may fire while state() is initializing, and awaiting it would
   * deadlock. It only bumps a module-level counter; tools() compares generations to invalidate the catalog cache.
   * Servers with the same name in different Instances cause one extra listTools for each other (harmless).
   */
  const toolListGeneration: Record<string, number> = {}
  let promptGeneration = 0

  /** Synchronous invalidation token; notification handlers must not await state(). */
  export function commandVersion() {
    return promptGeneration
  }

  // Register notification handlers for MCP client
  function registerNotificationHandlers(client: MCPClient, serverName: string) {
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      promptGeneration++
    })
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      log.info("tools list changed notification received", { server: serverName })
      toolListGeneration[serverName] = (toolListGeneration[serverName] ?? 0) + 1
      Bus.publish(ToolsChanged, { server: serverName })
    })
  }

  // Convert MCP tool definition to AI SDK Tool type
  async function convertMcpTool(mcpTool: MCPToolDef, client: MCPClient, timeout?: number): Promise<Tool> {
    const inputSchema = mcpTool.inputSchema

    // Spread first, then override type to ensure it's always "object"
    const schema: JSONSchema7 = {
      ...(inputSchema as JSONSchema7),
      type: "object",
      properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
      additionalProperties: false,
    }

    return dynamicTool({
      description: mcpTool.description ?? "",
      inputSchema: jsonSchema(schema),
      execute: async (args: unknown) => {
        return client.callTool(
          {
            name: mcpTool.name,
            arguments: (args || {}) as Record<string, unknown>,
          },
          CallToolResultSchema,
          {
            resetTimeoutOnProgress: true,
            timeout,
          },
        )
      },
    })
  }

  // Prompt cache types
  type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]

  type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
  type McpEntry = NonNullable<Config.Info["mcp"]>[string]
  function isMcpConfigured(entry: McpEntry): entry is Config.Mcp {
    return typeof entry === "object" && entry !== null && "type" in entry
  }

  type ToolCache = { generation: number; tools: MCPToolDef[] }
  interface Runtime {
    clients: Record<string, MCPClient>
    status: Record<string, Status>
    toolList: Record<string, ToolCache>
    disposed: boolean
  }
  // Reading a management snapshot must not start or await network initialization.
  const runtime = Instance.state(() => ({ current: undefined as Runtime | undefined }))

  export function cachedSnapshot() {
    const current = runtime().current
    const status: Record<string, Status> = {}
    const tools: Record<string, { count: number; tools: string[] }> = {}
    if (!current || current.disposed) return { status, tools }
    for (const [name, value] of Object.entries(current.status)) {
      status[name] = { ...value }
      const cached = current.toolList[name]
      if (value.status !== "connected" || !current.clients[name] || !cached) continue
      // The management view shows the last successful directory, even after a notification.
      // tools() still checks its generation before using it for model tool resolution.
      tools[name] = { count: cached.tools.length, tools: cached.tools.map((tool) => tool.name) }
    }
    return { status, tools }
  }

  function cacheTools(s: Runtime, name: string, client: MCPClient, cache: ToolCache) {
    if (s.disposed || s.clients[name] !== client || s.status[name]?.status !== "connected") return false
    s.toolList[name] = cache
    return true
  }

  /**
   * When the server side disconnects (local server process exited, remote connection dropped), its tools are
   * withdrawn and the status becomes failed. Our own disconnect, reconnect or Instance disposal does not count: the
   * client has already been replaced or is being disposed.
   */
  function track(s: Runtime, name: string, client: MCPClient) {
    const within = AsyncLocalStorage.snapshot()
    client.onclose = () =>
      within(() => {
        if (s.disposed || s.clients[name] !== client) return
        log.warn("mcp server connection closed", { name })
        s.status[name] = { status: "failed", error: "Connection closed" }
        delete s.clients[name]
        delete s.toolList[name]
        promptGeneration++
        void Bus.publish(ToolsChanged, { server: name }).catch(() => undefined)
      })
  }

  const state = Instance.state(
    async () => {
      const s: Runtime = { clients: {}, status: {}, toolList: {}, disposed: false }
      runtime().current = s
      const cfg = await Config.get()
      const config = cfg.mcp ?? {}
      const { clients, status } = s

      await Promise.all(
        Object.entries(config).map(async ([key, mcp]) => {
          if (!isMcpConfigured(mcp)) {
            log.error("Ignoring MCP config entry without type", { key })
            return
          }

          // If disabled by config, mark as disabled without trying to connect
          if (mcp.enabled === false) {
            status[key] = { status: "disabled" }
            return
          }

          const result = await create(key, mcp).catch(() => undefined)
          if (!result) return

          status[key] = result.status

          if (result.mcpClient) {
            clients[key] = result.mcpClient
            track(s, key, result.mcpClient)
            cacheTools(s, key, result.mcpClient, result.toolList)
          }
        }),
      )
      return s
    },
    async (state) => {
      state.disposed = true
      state.toolList = {}
      await Promise.all(
        Object.values(state.clients).map((client) =>
          client.close().catch((error) => {
            log.error("Failed to close MCP client", {
              error,
            })
          }),
        ),
      )
    },
  )

  // Helper function to fetch prompts for a specific client
  async function fetchPromptsForClient(clientName: string, client: Client) {
    const prompts = await client.listPrompts().catch((e) => {
      log.error("failed to get prompts", { clientName, error: e.message })
      return undefined
    })

    if (!prompts) {
      return
    }

    const commands: Record<string, PromptInfo & { client: string }> = {}

    for (const prompt of prompts.prompts) {
      const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
      const sanitizedPromptName = prompt.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const key = sanitizedClientName + ":" + sanitizedPromptName

      commands[key] = { ...prompt, client: clientName }
    }
    return commands
  }

  async function fetchResourcesForClient(clientName: string, client: Client) {
    const resources = await client.listResources().catch((e) => {
      log.error("failed to get prompts", { clientName, error: e.message })
      return undefined
    })

    if (!resources) {
      return
    }

    const commands: Record<string, ResourceInfo & { client: string }> = {}

    for (const resource of resources.resources) {
      const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
      const sanitizedResourceName = resource.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const key = sanitizedClientName + ":" + sanitizedResourceName

      commands[key] = { ...resource, client: clientName }
    }
    return commands
  }

  export async function add(name: string, mcp: Config.Mcp) {
    const s = await state()
    const result = await create(name, mcp)
    if (!result) {
      const status = {
        status: "failed" as const,
        error: "unknown error",
      }
      s.status[name] = status
      return {
        status,
      }
    }
    if (!result.mcpClient) {
      s.status[name] = result.status
      return {
        status: s.status,
      }
    }
    // Swap in the new client before closing the old one, so closing it does not count as a server disconnect (see
    // track)
    const existingClient = s.clients[name]
    s.clients[name] = result.mcpClient
    s.status[name] = result.status
    track(s, name, result.mcpClient)
    cacheTools(s, name, result.mcpClient, result.toolList)
    if (existingClient) {
      await existingClient.close().catch((error) => {
        log.error("Failed to close existing MCP client", { name, error })
      })
    }

    return {
      status: s.status,
    }
  }

  async function create(key: string, mcp: Config.Mcp) {
    if (mcp.enabled === false) {
      log.info("mcp server disabled", { key })
      return {
        mcpClient: undefined,
        status: { status: "disabled" as const },
      }
    }

    log.info("found", { key, type: mcp.type })
    let mcpClient: MCPClient | undefined
    let status: Status | undefined = undefined

    if (mcp.type === "remote") {
      const strategy = "transport" in mcp ? (mcp.transport ?? "auto") : "auto"
      const authProvider = mcp.oauth === false ? undefined : await transportProvider(key, oauthOptions(mcp))
      const options = {
        ...(mcp.headers ? { requestInit: { headers: mcp.headers } } : {}),
        ...(authProvider ? { authProvider } : {}),
      }
      const transports: Array<{ name: string; transport: StreamableHTTPClientTransport | SSEClientTransport }> = [
        ...(strategy === "auto" || strategy === "http"
          ? [{ name: "StreamableHTTP", transport: new StreamableHTTPClientTransport(new URL(mcp.url), options) }]
          : []),
        // The http strategy also falls back to SSE: configs without a transport connect over http by default, and
        // StreamableHTTP (POST) fails against SSE endpoints, so SSE (GET) is tried next.
        ...(strategy === "auto" || strategy === "http" || strategy === "sse"
          ? [{ name: "SSE", transport: new SSEClientTransport(new URL(mcp.url), options) }]
          : []),
      ]

      let lastError: Error | undefined
      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      for (const { name, transport } of transports) {
        let client: Client | undefined
        try {
          client = new Client({
            name: "merakcode",
            version: Installation.VERSION,
          })
          await withTimeout(client.connect(transport), connectTimeout)
          registerNotificationHandlers(client, key)
          mcpClient = client
          log.info("connected", { key, transport: name })
          status = { status: "connected" }
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          if (error instanceof UnauthorizedError) {
            status = { status: "needs_auth" }
            await client?.close().catch(() => undefined)
            await transport.close().catch(() => undefined)
            break
          }
          if (Network.failure(lastError) === "unreachable") {
            lastError = new Error(
              await Text.pick(
                {
                  zh: '无法连接到 MCP 服务 "{key}"，请确认该服务是否已启动、地址是否正确。',
                  en: 'Unable to connect to MCP server "{key}". Make sure it is running and the address is correct.',
                },
                { key },
              ),
              { cause: lastError },
            )
          }

          log.debug("transport connection failed", {
            key,
            transport: name,
            url: mcp.url,
            error: lastError.message,
          })
          status = {
            status: "failed" as const,
            error: lastError.message,
          }
          await client?.close().catch(() => undefined)
          await transport.close().catch(() => undefined)
        }
      }
    }

    if (mcp.type === "local") {
      const [cmd, ...args] = mcp.command
      const cwd = Instance.directory
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        // Drop unset (undefined) environment variables
        env: Object.fromEntries(
          Object.entries({ ...process.env, ...mcp.environment }).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      })
      transport.stderr?.on("data", (chunk: Buffer) => {
        log.info(`mcp stderr: ${chunk.toString()}`, { key })
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      let client: Client | undefined
      try {
        client = new Client({
          name: "merakcode",
          version: Installation.VERSION,
        })
        await withTimeout(client.connect(transport), connectTimeout)
        registerNotificationHandlers(client, key)
        mcpClient = client
        status = {
          status: "connected",
        }
      } catch (error) {
        log.error("local mcp startup failed", {
          key,
          command: mcp.command,
          cwd,
          error: error instanceof Error ? error.message : String(error),
        })
        status = {
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        }
        await client?.close().catch(() => undefined)
        await transport.close().catch(() => undefined)
      }
    }

    if (!status) {
      status = {
        status: "failed" as const,
        error: "Unknown error",
      }
    }

    if (!mcpClient) {
      return {
        mcpClient: undefined,
        status,
      }
    }

    const generation = toolListGeneration[key] ?? 0
    const result = await withTimeout(mcpClient.listTools(), mcp.timeout ?? DEFAULT_TIMEOUT).catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return undefined
    })
    if (!result) {
      await mcpClient.close().catch((error) => {
        log.error("Failed to close MCP client", {
          error,
        })
      })
      status = {
        status: "failed",
        error: "Failed to get tools",
      }
      return {
        mcpClient: undefined,
        status: {
          status: "failed" as const,
          error: "Failed to get tools",
        },
      }
    }

    log.info("create() successfully created client", { key, toolCount: result.tools.length })
    return {
      mcpClient,
      status,
      toolList: { generation, tools: result.tools },
    }
  }

  async function scopes() {
    const [global, project] = await Promise.all([
      Config.getGlobal().catch(() => ({}) as Config.Info),
      Config.loadProjectMerakCodeFile().catch(() => ({}) as Config.Info),
    ])
    return {
      ...Object.fromEntries(Object.keys(global.mcp ?? {}).map((name) => [name, "global" as const])),
      ...Object.fromEntries(Object.keys(project.mcp ?? {}).map((name) => [name, "project" as const])),
    }
  }

  function requireRemoteOAuth(name: string, mcp: Config.Mcp | undefined) {
    if (!mcp) throw new McpServerNotFoundError({ name })
    if (mcp.type !== "remote" || mcp.oauth === false) throw new McpUnsupportedOAuthError({ name })
    return mcp
  }

  /** Starts OAuth and returns the authorization URL. The engine does not open a browser. */
  export async function startAuth(name: string) {
    const cfg = await Config.get()
    const mcp = cfg.mcp?.[name]
    const remote = requireRemoteOAuth(name, mcp && isMcpConfigured(mcp) ? mcp : undefined)
    return beginOAuthFlow(name, remote.url, oauthOptions(remote))
  }

  /** Exchanges the authorization code for tokens and tries to connect. */
  export async function finishAuth(name: string, code: string) {
    const cfg = await Config.get()
    const mcp = cfg.mcp?.[name]
    const remote = requireRemoteOAuth(name, mcp && isMcpConfigured(mcp) ? mcp : undefined)
    await exchangeOAuth(name, remote.url, code, oauthOptions(remote))
    await connect(name)
    const s = await state()
    return s.status[name] ?? { status: "failed" as const, error: "unknown" }
  }

  /** Waits for the browser callback of the authorization started by startAuth, then exchanges the code and connects */
  export async function waitAuth(name: string, state: string) {
    return finishAuth(name, await waitForBrowserCode(state))
  }

  export async function removeAuth(name: string) {
    const cfg = await Config.get()
    const mcp = cfg.mcp?.[name]
    if (!mcp || !isMcpConfigured(mcp)) throw new McpServerNotFoundError({ name })
    await removeOAuth(name)
    return { success: true as const }
  }

  export async function status() {
    const s = await state()
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const source = await scopes()
    const result: Record<string, Status> = {}

    // Include all configured MCPs from config, not just connected ones
    for (const [key, mcp] of Object.entries(config)) {
      if (!isMcpConfigured(mcp)) continue
      const current = s.status[key] ?? { status: "disabled" as const }
      result[key] = { ...current, scope: source[key] ?? "project" }
    }

    return result
  }

  export async function clients() {
    return state().then((state) => state.clients)
  }

  export async function connect(name: string) {
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const mcp = config[name]
    if (!mcp) {
      log.error("MCP config not found", { name })
      return
    }

    if (!isMcpConfigured(mcp)) {
      log.error("Ignoring MCP connect request for config without type", { name })
      return
    }

    const result = await create(name, { ...mcp, enabled: true })

    if (!result) {
      const s = await state()
      s.status[name] = {
        status: "failed",
        error: "Unknown error during connection",
      }
      promptGeneration++
      return
    }

    const s = await state()
    s.status[name] = result.status
    promptGeneration++
    if (result.mcpClient) {
      // Swap in the new client before closing the old one, so closing it does not count as a server disconnect (see
      // track)
      const existingClient = s.clients[name]
      s.clients[name] = result.mcpClient
      track(s, name, result.mcpClient)
      cacheTools(s, name, result.mcpClient, result.toolList)
      if (existingClient) {
        await existingClient.close().catch((error) => {
          log.error("Failed to close existing MCP client", { name, error })
        })
      }
    }
  }

  export async function disconnect(name: string) {
    await disconnectResult(name)
  }

  export async function disconnectResult(name: string) {
    const s = await state()
    const client = s.clients[name]
    // Remove before closing, so our own disconnect does not count as a server disconnect (see track)
    delete s.clients[name]
    delete s.toolList[name]
    s.status[name] = { status: "disabled" }
    promptGeneration++
    return client
      ? client.close().then(
          () => ({ ok: true as const }),
          (error) => {
            log.error("Failed to close MCP client", { name, error })
            return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
          },
        )
      : { ok: true as const }
  }

  export async function tools() {
    const result: Record<string, Tool> = {}
    const s = await state()
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const clientsSnapshot = await clients()
    const defaultTimeout = cfg.experimental?.mcp_timeout

    // clientsSnapshot is ordered by which concurrent connection finished first (see Promise.all in state()), which
    // changes across restarts and reconnects. Sorting by clientName keeps the tools array byte-stable between turns,
    // so the prompt cache prefix keeps hitting.
    const connectedClients = Object.entries(clientsSnapshot)
      .filter(([clientName]) => s.status[clientName]?.status === "connected")
      .sort(([a], [b]) => a.localeCompare(b))

    const toolsResults = await Promise.all(
      connectedClients.map(async ([clientName, client]) => {
        // Catalog cache: tool-list-changed bumps toolListGeneration[clientName], and a generation mismatch invalidates
        // it. A hit reuses the cached tool definitions and skips the listTools() round trip (network IO on the
        // critical path of every turn for remote servers).
        const gen = toolListGeneration[clientName] ?? 0
        const cached = s.toolList[clientName]
        if (cached && cached.generation === gen) {
          return { clientName, client, toolsResult: { tools: cached.tools } }
        }
        const toolsResult = await client.listTools().catch((e) => {
          log.error("failed to get tools", { clientName, error: e.message })
          if (s.disposed || s.clients[clientName] !== client) return undefined
          const failedStatus = {
            status: "failed" as const,
            error: e instanceof Error ? e.message : String(e),
          }
          s.status[clientName] = failedStatus
          delete s.clients[clientName]
          delete s.toolList[clientName]
          void client.close().catch((error) => {
            log.error("Failed to close unhealthy MCP client", { clientName, error })
          })
          return undefined
        })
        if (toolsResult && !cacheTools(s, clientName, client, { generation: gen, tools: toolsResult.tools })) {
          return { clientName, client, toolsResult: undefined }
        }
        return { clientName, client, toolsResult }
      }),
    )

    for (const { clientName, client, toolsResult } of toolsResults) {
      if (!toolsResult) continue
      const mcpConfig = config[clientName]
      const entry = isMcpConfigured(mcpConfig) ? mcpConfig : undefined
      const timeout = entry?.timeout ?? defaultTimeout
      // MCP does not guarantee a stable listTools() order; sort by name so a server's own order cannot jitter
      const sortedTools = [...toolsResult.tools].sort((a, b) => a.name.localeCompare(b.name))
      for (const mcpTool of sortedTools) {
        const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
        const sanitizedToolName = mcpTool.name.replace(/[^a-zA-Z0-9_-]/g, "_")
        const id = sanitizedClientName + "_" + sanitizedToolName
        const tool = await convertMcpTool(mcpTool, client, timeout)
        // Deferred MCP tools (as in Claude Code): only an explicit deferred:true defers a tool; otherwise it stays
        // loaded. The __deferred marker lets runner/context-view leave it out of the tools array. It is an extra
        // property rather than a change to the return type of tools(), which would affect every caller.
        if (entry?.deferred === true) (tool as any).__deferred = true
        result[id] = tool
      }
    }
    return result
  }

  export async function prompts() {
    const s = await state()
    const clientsSnapshot = await clients()

    const prompts = Object.fromEntries<PromptInfo & { client: string }>(
      (
        await Promise.all(
          Object.entries(clientsSnapshot).map(async ([clientName, client]) => {
            if (s.status[clientName]?.status !== "connected") {
              return []
            }

            return Object.entries((await fetchPromptsForClient(clientName, client)) ?? {})
          }),
        )
      ).flat(),
    )

    return prompts
  }

  export async function resources() {
    const s = await state()
    const clientsSnapshot = await clients()

    const result = Object.fromEntries<ResourceInfo & { client: string }>(
      (
        await Promise.all(
          Object.entries(clientsSnapshot).map(async ([clientName, client]) => {
            if (s.status[clientName]?.status !== "connected") {
              return []
            }

            return Object.entries((await fetchResourcesForClient(clientName, client)) ?? {})
          }),
        )
      ).flat(),
    )

    return result
  }

  export async function getPrompt(clientName: string, name: string, args?: Record<string, string>) {
    const clientsSnapshot = await clients()
    const client = clientsSnapshot[clientName]

    if (!client) {
      log.warn("MCP prompt client unavailable", { clientName, promptName: name })
      throw new Error("MCP prompt client unavailable")
    }

    const result = await client
      .getPrompt({
        name: name,
        arguments: args,
      })
      .catch((e) => {
        log.warn("MCP prompt retrieval failed", { clientName, promptName: name, ...failure(e) })
        throw new Error("MCP prompt retrieval failed")
      })

    return result
  }

  export async function readResource(clientName: string, resourceUri: string) {
    const clientsSnapshot = await clients()
    const client = clientsSnapshot[clientName]

    if (!client) {
      log.warn("client not found for prompt", {
        clientName: clientName,
      })
      return undefined
    }

    const result = await client
      .readResource({
        uri: resourceUri,
      })
      .catch((e) => {
        log.error("failed to get prompt from MCP server", {
          clientName: clientName,
          resourceUri: resourceUri,
          error: e.message,
        })
        return undefined
      })

    return result
  }

  /**
   * Deletes an MCP server: disconnects it first (removes the client, status becomes disabled), then removes
   * mcp[name] from the config file.
   */
  export async function deleteMcpServer(name: string, scope: "project" | "global" = "global") {
    await disconnect(name)
    await Config.deleteMcpServer(name, scope)
  }
}
