import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import { Log } from "@merakcode/log/logger"
import { describeRoute, generateSpecs, resolver, openAPIRouteHandler } from "hono-openapi"
import { validator } from "./validator"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { bodyLimit } from "hono/body-limit"
import { randomUUID } from "node:crypto"
import { streamSSE } from "hono/streaming"
import { authorizeLocalRequest } from "../auth/local-guard"
import { getLocalSecret } from "../auth/local-secret"
import { runWithPeer } from "../auth/peer-context"
import { failure } from "@merakcode/log"
import z from "zod"
import { Provider } from "../provider/provider"
import { NamedError } from "@merakcode/util/error"
import { LSP } from "../lsp"
import { Format } from "../format"
import { Instance } from "../project/instance"
import { Workspace } from "../project/workspace"
import { Vcs } from "../project/vcs"
import { Sandbox } from "../sandbox"
import { Agent } from "../agent/agent"
import { Skill } from "../skill/skill"
import { SkillInstall } from "../skill/install"
import { Config } from "../config/config"
import { Auth } from "../auth"
import { Flag } from "../flag/flag"
import { Text } from "../util/text"
import { Command } from "../command"
import { Global } from "../global"
import { ProjectRoutes } from "./routes/project"
import { SessionRoutes } from "./routes/session"
import { MemoryRoutes } from "./routes/memory"
import { BashRoutes } from "./routes/bash"
import { ToolRoutes } from "./routes/tool"
import { PtyRoutes } from "./routes/pty"
import { McpRoutes } from "./routes/mcp"
import { FileRoutes } from "./routes/file"
import { CollaborationRoutes } from "./routes/collaboration"
import { ConfigRoutes } from "./routes/config"
import { ExperimentalRoutes } from "./routes/experimental"
import { ProviderRoutes } from "./routes/provider"
import { lazy } from "../util/lazy"
import { InstanceBootstrap } from "../project/bootstrap"
import { ConfigWatch } from "../config/config-watch"
import { SkillWatch } from "../skill/skill-watch"
import { RuleWatch } from "../rule/watch"
import { resolveSkillInstallRoot } from "../skill/uninstall"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { serve } from "@hono/node-server"
import type { Server as HttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Http } from "@merakcode/util/http"
import { WebSocketServer } from "ws"
import { HTTPException } from "hono/http-exception"
import { ErrorCode } from "@merakcode/util/error-code"
import { errors } from "./error"
import { ServerAddress } from "./address"
import { QuestionRoutes } from "./routes/question"
import { PermissionRoutes } from "./routes/permission"
import { GlobalRoutes } from "./routes/global"
import { WorkflowRoutes } from "./routes/workflow"
import { ReviewRoutes } from "./routes/review"
import { AssistRoutes } from "./routes/assist"
import { PluginRoutes } from "./routes/plugin"
import { RuleRoutes } from "./routes/rule"
import { MDNS } from "./mdns"
import { createReadStream, existsSync, realpathSync } from "fs"
import { Readable } from "stream"
import { Filesystem } from "@merakcode/util/filesystem"
import { dirname, join, resolve, sep, relative } from "path"
import { rm } from "fs/promises"
import { connectProvider, disconnectProvider } from "../provider/auth-mutate"
import { EventStream } from "./event-stream"
import { appAssetHeaders, isFrontendStaticAssetPath, resolveAssetContentType } from "./app-security"
import { AppDev } from "./app-dev"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

const SkillInstallSourceSchema = z.union([
  z.object({
    type: z.literal("github"),
    url: z.string(),
    owner: z.string(),
    repo: z.string(),
    branch: z.string().optional(),
  }),
  z.object({
    type: z.literal("url"),
    url: z.string(),
  }),
])

const SkillInstallEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  repoPath: z.string(),
  // Directory inside the repository (POSIX). Optional because older clients and responses omit it.
  path: z.string().optional(),
  files: z.array(z.string()),
})

const SkillInstallResultSchema = z.object({
  installed: z.array(z.string()),
  failed: z.array(
    z.object({
      name: z.string(),
      error: z.string(),
    }),
  ),
})

import enginePackage from "../../package.json"
import { Glob } from "@merakcode/util/glob"

const McpManagementRoutes = (await import("./routes/mcp-management")).McpManagementRoutes

/** A file on disk as a web stream response body, so large files are not read into memory */
function fileStream(p: string) {
  return Readable.toWeb(createReadStream(p)) as unknown as ReadableStream<Uint8Array>
}

/** JSON error body shared by every failure path: name, catalog code, readable message and request id */
function errorBody(name: string, error: ErrorCode.Name, message: string, c: { res: { headers: Headers } }) {
  return {
    name,
    code: ErrorCode.CATALOG[error].code,
    message,
    data: {},
    requestID: c.res.headers.get("x-request-id") ?? undefined,
  }
}

export namespace Server {
  const log = Log.create({ service: "server" })
  let logWindow = 0
  let logCount = 0

  let _url: URL | undefined
  let _corsWhitelist: string[] = []

  export function url(): URL {
    return _url ?? new URL("http://localhost:4096")
  }

  /**
   * Composes the routes. `extend` adds routes before the static asset / SPA fallback (tests use it to mount a route
   * that throws). Pass a new Hono instance on every call: Hono freezes its router after the first request.
   */
  export function compose(app: Hono, extend?: (app: Hono) => Hono): Hono {
    const routed = app
      .onError((err, c) => {
        const requestID = c.res.headers.get("x-request-id")
        const cancelled = err.name === "AbortError" || err.name === "MessageAbortedError"
        if (cancelled) log.info("request cancelled", { requestID, ...failure(err, true) })
        else log.error("failed", { error: err, requestID })
        if (err instanceof NamedError) {
          const object = err.toObject()
          const spec = ErrorCode.spec(object.code ?? "")
          const message = typeof object.data?.message === "string" ? object.data.message : spec?.title.en
          return c.json(
            { ...object, message, requestID: requestID ?? undefined },
            (spec?.status ?? 500) as ContentfulStatusCode,
          )
        }
        if (err instanceof HTTPException) {
          const name = err.status === 404 ? "NOT_FOUND" : err.status === 403 ? "FORBIDDEN" : "BAD_REQUEST"
          return c.json(errorBody("HTTPError", name, err.message, c), err.status)
        }
        // The stack stays in the log; the client only gets the request id to quote
        return c.json(
          errorBody("UnknownError", "INTERNAL", `Internal error. Quote request ${requestID} when reporting it.`, c),
          500,
        )
      })
      .use(async (c, next) => {
        if (c.req.path === "/log") return next()
        const requestID = randomUUID()
        const started = Date.now()
        c.header("x-request-id", requestID)
        const client = c.req.header("x-merakcode-client-run")
        const context = {
          requestID,
          method: c.req.method,
          path: c.req.path,
          ...(client && /^[\w.:-]{1,100}$/.test(client) ? { clientRun: client } : {}),
        }
        log.debug("request started", context)
        await next()
        const status = c.res.status
        const cancelled = c.error?.name === "AbortError" || c.error?.name === "MessageAbortedError"
        const level = cancelled ? "info" : status >= 500 ? "error" : status >= 400 ? "warn" : "info"
        log[level]("request completed", {
          ...context,
          status,
          duration: Date.now() - started,
          ...(cancelled ? failure(c.error, true) : {}),
        })
      })
      .use(async (c, next) => {
        // Allow CORS preflight requests to succeed without auth.
        // Browser clients sending Authorization headers will preflight with OPTIONS.
        if (c.req.method === "OPTIONS") return next()
        const password = getLocalSecret()
        if (!password) return next()
        const username = Flag.MERAKCODE_SERVER_USERNAME ?? "merakcode"
        const listenPort = Number(_url?.port)
        const decision = await authorizeLocalRequest({
          method: c.req.method,
          path: c.req.path,
          headers: c.req.raw.headers,
          secret: password,
          username,
          parentPid: Flag.MERAKCODE_SERVER_PARENT_PID,
          engine: process.pid,
          listenPort: Number.isInteger(listenPort) && listenPort > 0 ? listenPort : undefined,
        })
        if (decision === "unauthorized")
          return c.json(errorBody("UnauthorizedError", "UNAUTHORIZED", "Wrong or missing engine password", c), 401)
        if (decision === "forbidden")
          return c.json(
            errorBody("ForbiddenError", "FORBIDDEN", "This endpoint is not available to this process", c),
            403,
          )
        return next()
      })
      .use(
        cors({
          origin(input) {
            if (!input) return

            if (input.startsWith("http://localhost:")) return input
            if (input.startsWith("http://127.0.0.1:")) return input
            if (
              input === "tauri://localhost" ||
              input === "http://tauri.localhost" ||
              input === "https://tauri.localhost"
            )
              return input

            if (_corsWhitelist.includes(input)) {
              return input
            }

            return
          },
        }),
      )
      // `/global/event` and `/event` below must use the same exclusion set, otherwise the standard openapi keeps
      // orphan `Event.<product event>` schemas (see routes/global.ts).
      .route("/global", GlobalRoutes())
      .get(
        "/auth",
        describeRoute({
          summary: "List stored credentials",
          description:
            "List the providers that have stored credentials and their credential type, plus the credentials file. Secrets are never returned.",
          operationId: "auth.list",
          responses: {
            200: {
              description: "Stored credentials",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      file: z.string(),
                      credentials: z.array(
                        z.object({ providerID: z.string(), type: z.enum(["oauth", "api", "wellknown"]) }),
                      ),
                    }),
                  ),
                },
              },
            },
          },
        }),
        async (c) =>
          c.json({
            file: Auth.file,
            credentials: Object.entries(await Auth.all()).map(([providerID, info]) => ({
              providerID,
              type: info.type,
            })),
          }),
      )
      .put(
        "/auth/:providerID",
        describeRoute({
          summary: "Set auth credentials",
          description: "Set authentication credentials",
          operationId: "auth.set",
          responses: {
            200: {
              description: "Successfully set authentication credentials",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: z.string(),
          }),
        ),
        validator("json", Auth.Info),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          const info = c.req.valid("json")
          // Invalidate the Provider cache after writing credentials, or provider.list still shows "not connected".
          await connectProvider(providerID, info, {
            set: Auth.set,
            refresh: (id) => Provider.refreshCatalog(id, true),
            invalidate: Provider.invalidateAll,
            changed: () => Provider.publishChanged({ providerID, reason: "connected" }),
          })
          return c.json(true)
        },
      )
      .delete(
        "/auth/:providerID",
        describeRoute({
          summary: "Remove auth credentials",
          description: "Remove authentication credentials",
          operationId: "auth.remove",
          responses: {
            200: {
              description: "Successfully removed authentication credentials",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: z.string(),
          }),
        ),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          // Invalidate the Provider cache after removing credentials, or provider.list still shows "connected".
          await disconnectProvider(providerID, {
            remove: Auth.remove,
            invalidate: Provider.invalidateAll,
            changed: () => Provider.publishChanged({ providerID, reason: "disconnected" }),
          })
          return c.json(true)
        },
      )
      .use(async (c, next) => {
        if (c.req.path === "/log") return next()
        // Directory precedence: query parameter, then the x-merakcode-directory header, then the process cwd.
        //
        // `?directory=` must stay first: for GET/HEAD the SDK rewrites the directory header into a query parameter.
        const raw = c.req.query("directory") || c.req.header("x-merakcode-directory") || process.cwd()
        const directory = (() => {
          try {
            return decodeURIComponent(raw)
          } catch {
            return raw
          }
        })()
        // Multi-root: the desktop app sends x-merakcode-workspace-folders; the CLI does not (single root).
        const folders = Workspace.parseFoldersHeader(c.req.header("x-merakcode-workspace-folders"))
        return Instance.provide({
          directory,
          workspace: folders ? { folders } : undefined,
          init: InstanceBootstrap,
          async fn() {
            return next()
          },
        })
      })
      .get(
        "/doc",
        openAPIRouteHandler(app, {
          documentation: {
            info: {
              title: "merakcode",
              version: enginePackage.version,
              description: "merakcode api",
            },
            openapi: "3.1.1",
          },
        }),
      )
      .use(validator("query", z.object({ directory: z.string().optional() })))
      .route("/project", ProjectRoutes())
      .route("/pty", PtyRoutes())
      .route("/config", ConfigRoutes())
      .route("/experimental", ExperimentalRoutes())
      .route("/session", SessionRoutes())
      .route("/collaboration", CollaborationRoutes())
      // Memory management (for people) must be mounted after the directory middleware: the memory directory is
      // located by Instance.worktree, which is wrong outside the Instance context.
      .route("/memory", MemoryRoutes())
      .route("/bash", BashRoutes())
      .route("/tool", ToolRoutes())
      .route("/permission", PermissionRoutes())
      .route("/question", QuestionRoutes())
      .route("/provider", ProviderRoutes())
      .route("/plugin", PluginRoutes())
      .route("/workflow", WorkflowRoutes())
      .route("/review", ReviewRoutes())
      .route("/mcp-management", McpManagementRoutes())
      .route("/rule", RuleRoutes())
      .route("/", FileRoutes())
      .route("/mcp", McpRoutes())
      .route("/assist", AssistRoutes())
      .post(
        "/instance/dispose",
        describeRoute({
          summary: "Dispose instance",
          description: "Clean up and dispose the current MerakCode instance, releasing all resources.",
          operationId: "instance.dispose",
          responses: {
            200: {
              description: "Instance disposed",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
          },
        }),
        async (c) => {
          await Instance.dispose()
          return c.json(true)
        },
      )
      .get(
        "/path",
        describeRoute({
          summary: "Get paths",
          description:
            "Retrieve the current working directory and related path information for the MerakCode instance.",
          operationId: "path.get",
          responses: {
            200: {
              description: "Path",
              content: {
                "application/json": {
                  schema: resolver(
                    z
                      .object({
                        home: z.string(),
                        data: z.string(),
                        config: z.string(),
                        worktree: z.string(),
                        directory: z.string(),
                        workspace: z
                          .object({
                            primary: z.string(),
                            /** Workspace identity; only present for multi-root workspaces */
                            id: z.string().optional(),
                            folders: z.array(
                              z.object({
                                name: z.string(),
                                path: z.string(),
                                worktree: z.string().optional(),
                              }),
                            ),
                          })
                          .optional(),
                      })
                      .meta({
                        ref: "Path",
                      }),
                  ),
                },
              },
            },
          },
        }),
        async (c) => {
          const workspace = Instance.workspace
          return c.json({
            home: Global.Path.home,
            data: Global.Path.data,
            config: Global.Path.config,
            worktree: Instance.worktree,
            directory: Instance.directory,
            workspace: {
              primary: workspace.primary,
              id: workspace.identity?.id,
              folders: workspace.folders.map((f) => ({
                name: f.name,
                path: f.path,
                worktree: f.worktree === "/" ? undefined : f.worktree,
              })),
            },
          })
        },
      )
      .get(
        "/vcs",
        describeRoute({
          summary: "Get VCS info",
          description: "Retrieve version control system (VCS) information for the current project, such as git branch.",
          operationId: "vcs.get",
          responses: {
            200: {
              description: "VCS info",
              content: {
                "application/json": {
                  schema: resolver(Vcs.Info),
                },
              },
            },
          },
        }),
        async (c) => c.json((await Vcs.status()) ?? { branch: "", staged: 0, unstaged: 0, untracked: 0 }),
      )
      .get(
        "/vcs/branches",
        describeRoute({
          summary: "List branches",
          description: "Local branch names, sorted.",
          operationId: "vcs.branches",
          responses: {
            200: {
              description: "Branch names",
              content: { "application/json": { schema: resolver(z.string().array()) } },
            },
          },
        }),
        async (c) => c.json(await Vcs.branches()),
      )
      .post(
        "/vcs/push",
        describeRoute({
          summary: "Push",
          description:
            "Push the current branch to its upstream, or to the remote (origin or the only remote) and set it as upstream. Uses the user's own git credentials.",
          operationId: "vcs.push",
          responses: {
            200: { description: "Push result", content: { "application/json": { schema: resolver(Vcs.PushResult) } } },
          },
        }),
        async (c) => c.json(await Vcs.push()),
      )
      .post(
        "/vcs/run",
        describeRoute({
          summary: "Run a git command",
          description:
            "Run git with the given arguments in the worktree. The executable is git; arguments are not passed through a shell.",
          operationId: "vcs.run",
          responses: {
            200: {
              description: "Command output",
              content: { "application/json": { schema: resolver(Vcs.RunResult) } },
            },
          },
        }),
        validator("json", z.object({ args: z.array(z.string().max(2000)).min(1).max(64) })),
        async (c) => c.json(await Vcs.runGit(c.req.valid("json").args)),
      )
      .get(
        "/sandbox",
        describeRoute({
          summary: "Get sandbox status",
          description:
            "Whether agent-run commands run inside the OS sandbox: on, off (disabled in config) or unsupported (missing dependencies or platform), with the reason.",
          operationId: "sandbox.status",
          responses: {
            200: {
              description: "Sandbox status",
              content: {
                "application/json": {
                  schema: resolver(Sandbox.Info),
                },
              },
            },
          },
        }),
        async (c) => c.json(await Sandbox.current()),
      )
      .post(
        "/sandbox/install",
        describeRoute({
          summary: "Set up the sandbox",
          description:
            "Windows only: create the sandbox account and its firewall rule (one UAC prompt) and give it access to the right folders, then report the new status. A no-op elsewhere, where the sandbox needs no setup.",
          operationId: "sandbox.install",
          responses: {
            200: {
              description: "Sandbox status after the install",
              content: {
                "application/json": {
                  schema: resolver(Sandbox.Info),
                },
              },
            },
          },
        }),
        async (c) => c.json(await Sandbox.install()),
      )
      .post(
        "/sandbox/reset",
        describeRoute({
          summary: "Reset the sandbox",
          description:
            "Undo the sandbox setup: on Windows, take back every folder permission given to the sandbox account, then delete the account and its firewall rule (one UAC prompt). A no-op elsewhere.",
          operationId: "sandbox.reset",
          responses: {
            200: {
              description: "Sandbox status after the reset",
              content: {
                "application/json": {
                  schema: resolver(Sandbox.Info),
                },
              },
            },
          },
        }),
        async (c) => c.json(await Sandbox.reset()),
      )
      .get(
        "/vcs/diff",
        describeRoute({
          summary: "Get VCS diff",
          description: "Get working-tree / branch diff as unified patches.",
          operationId: "vcs.diff",
          responses: {
            200: {
              description: "VCS diff",
              content: {
                "application/json": {
                  schema: resolver(Vcs.FileDiff.array()),
                },
              },
            },
          },
        }),
        validator(
          "query",
          z.object({
            mode: Vcs.Mode.optional(),
            context: z.coerce.number().int().min(0).optional(),
          }),
        ),
        async (c) => {
          const { mode, context } = c.req.valid("query")
          const result = await Vcs.diff({ mode: mode ?? "git", context })
          return c.json(result)
        },
      )
      .post(
        "/vcs/commit",
        describeRoute({
          summary: "Commit changes",
          description: "Commit staged changes (or all changes with all=true) using the user's git identity.",
          operationId: "vcs.commit",
          responses: {
            200: {
              description: "Commit result",
              content: { "application/json": { schema: resolver(Vcs.CommitResult) } },
            },
          },
        }),
        validator("json", z.object({ message: z.string(), all: z.boolean().optional() })),
        async (c) => c.json(await Vcs.commit(c.req.valid("json"))),
      )
      .get(
        "/command",
        describeRoute({
          summary: "List commands",
          description: "Get a list of all available commands in the MerakCode system.",
          operationId: "command.list",
          responses: {
            200: {
              description: "List of commands",
              content: {
                "application/json": {
                  schema: resolver(Command.Info.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          // Refresh the skill and command caches so added or removed skills show up in the slash commands at once.
          Skill.state.invalidate()
          Command.state.invalidate()
          const commands = await Command.list()
          return c.json(commands)
        },
      )
      .post(
        "/log",
        bodyLimit({ maxSize: 64 * 1024 }),
        async (c, next) => {
          const window = Math.floor(Date.now() / 1000)
          if (window !== logWindow) {
            logWindow = window
            logCount = 0
          }
          if (++logCount > 200) return c.json(false, 429)
          return next()
        },
        describeRoute({
          summary: "Write log",
          description: "Write a log entry to the server logs with specified level and metadata.",
          operationId: "app.log",
          responses: {
            200: {
              description: "Log entry written successfully",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "json",
          z.object({
            component: z.enum(["web", "desktop"]).optional().meta({ description: "Client component" }),
            service: z.string().max(100).meta({ description: "Service name for the log entry" }),
            level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
            message: z.string().max(8192).meta({ description: "Log message" }),
            run_id: z.string().max(100).optional().meta({ description: "Client run identifier" }),
            sequence: z.number().int().nonnegative().optional().meta({ description: "Client record sequence" }),
            extra: z
              .record(z.string(), z.any())
              .optional()
              .meta({ description: "Additional metadata for the log entry" }),
          }),
        ),
        async (c) => {
          const { component, service, level, message, run_id, sequence, extra } = c.req.valid("json")
          if (component) {
            Log.ingest({
              component,
              service,
              level: level.toUpperCase() as Log.Level,
              message,
              runId: run_id,
              sequence,
              extra,
            })
            return c.json(true)
          }
          const logger = Log.create({ service }, true)

          switch (level) {
            case "debug":
              logger.debug(message, extra)
              break
            case "info":
              logger.info(message, extra)
              break
            case "error":
              logger.error(message, extra)
              break
            case "warn":
              logger.warn(message, extra)
              break
          }

          return c.json(true)
        },
      )
      .get(
        "/agent",
        describeRoute({
          summary: "List agents",
          description: "Get a list of all available AI agents in the MerakCode system.",
          operationId: "app.agents",
          responses: {
            200: {
              description: "List of agents",
              content: {
                "application/json": {
                  schema: resolver(Agent.Info.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          const modes = await Agent.list()
          return c.json(modes)
        },
      )
      .post(
        "/agent/generate",
        describeRoute({
          summary: "Generate agent",
          description:
            "Ask a model to draft an agent (identifier, when to use it, system prompt) from a description. Nothing is written; the client saves it.",
          operationId: "app.agentGenerate",
          responses: {
            200: {
              description: "Generated agent",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({ identifier: z.string(), whenToUse: z.string(), systemPrompt: z.string() }),
                  ),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "json",
          z.object({
            description: z.string().min(1),
            model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
          }),
        ),
        async (c) => c.json(await Agent.generate(c.req.valid("json"))),
      )
      .get(
        "/skill",
        describeRoute({
          summary: "List skills",
          description: "Get a list of all available skills in the MerakCode system.",
          operationId: "app.skills",
          responses: {
            200: {
              description: "List of skills",
              content: {
                "application/json": {
                  schema: resolver(Skill.Info.array()),
                },
              },
            },
          },
        }),
        validator("query", z.object({ directory: z.string().optional() })),
        async (c) => {
          Skill.state.invalidate()
          const skills = await Skill.all()
          // Also scan skills in the client's current directory, which may differ from the server's start directory.
          const { directory } = c.req.valid("query")
          if (directory) {
            const searchRoot = join(directory, ".merakcode")
            // Skip a missing directory; Glob.scan would throw ENOENT.
            const dirExists = await import("fs/promises").then((fs) =>
              fs
                .stat(searchRoot)
                .then((s) => s.isDirectory())
                .catch(() => false),
            )
            if (dirExists) {
              try {
                const { ConfigMarkdown } = await import("../config/markdown")
                const glob = new Glob("{skill,skills}/**/SKILL.md")
                const seen = new Set(skills.map((s) => s.location))
                for await (const match of glob.scan({
                  cwd: searchRoot,
                  absolute: true,
                  onlyFiles: true,
                  followSymlinks: true,
                })) {
                  const md = await ConfigMarkdown.parse(match).catch(() => undefined)
                  // Use name/slug/display_name from the frontmatter, falling back to the parent directory name
                  // (SKILL.md files from the MOSS marketplace may use slug instead of name).
                  const dirName = dirname(match).split(sep).pop() ?? ""
                  const data = md?.data as Record<string, unknown> | undefined
                  const description = typeof data?.description === "string" ? data.description : ""
                  if (seen.has(match)) continue
                  seen.add(match)
                  skills.push({
                    name: dirName,
                    description,
                    location: match,
                    content: md?.content ?? "",
                    scope: "project" as const,
                  })
                }
              } catch {
                // A failed scan is skipped; skills found so far are kept.
              }
            }
          }
          return c.json(skills)
        },
      )
      .post(
        "/skill-install/list",
        describeRoute({
          summary: "List installable skills from source",
          description: "List skills available to install from a GitHub repo or URL.",
          operationId: "skillInstall.list",
          responses: {
            200: {
              description: "Source and list of skills",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      source: SkillInstallSourceSchema,
                      skills: SkillInstallEntrySchema.array(),
                    }),
                  ),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "json",
          z.object({
            source: z.string(),
            // Optional access token for private repositories (gitee/github PAT), used for this clone only.
            token: z.string().optional(),
          }),
        ),
        async (c) => {
          const { source, token } = c.req.valid("json")
          const parsed = SkillInstall.parse(source)
          if (parsed.type === "invalid") {
            throw new HTTPException(400, {
              message: await Text.pick({
                zh: "无法识别的格式，请输入 owner/repo 或 URL",
                en: "Unrecognized format; enter owner/repo or a URL",
              }),
            })
          }
          const withAuth = parsed.type === "github" && token ? { ...parsed, auth: { token } } : parsed
          return c.json(await SkillInstall.list(withAuth))
        },
      )
      .post(
        "/skill-install/install",
        describeRoute({
          summary: "Install skills",
          description: "Install selected skills to project or global directory.",
          operationId: "skillInstall.install",
          responses: {
            200: {
              description: "Install result",
              content: {
                "application/json": {
                  schema: resolver(SkillInstallResultSchema),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "json",
          z.object({
            source: SkillInstallSourceSchema,
            skills: z.array(SkillInstallEntrySchema),
            target: z.enum(["project", "global"]),
            directory: z.string().optional(),
          }),
        ),
        async (c) => {
          const { source, skills, target, directory } = c.req.valid("json")
          const result = await SkillInstall.install(source, skills, target, directory)
          if (result.installed.length > 0) {
            Config.state.invalidate()
            Skill.state.invalidate()
            Command.state.invalidate()
            // Tell clients to reload the command list so the new skill appears in the slash menu.
            void Bus.publish(Config.UpdatedEvent, {})
          }
          return c.json(result)
        },
      )
      .post(
        "/skill-uninstall",
        describeRoute({
          summary: "Uninstall skill",
          description: "Remove a user-installed skill from project or global directory.",
          operationId: "skill.uninstall",
          responses: {
            200: {
              description: "Uninstall result",
              content: {
                "application/json": {
                  schema: resolver(z.object({ name: z.string(), deleted: z.boolean() })),
                },
              },
            },
            ...errors(400, 403),
          },
        }),
        validator(
          "json",
          z.object({
            name: z.string(),
            location: z.string(),
          }),
        ),
        async (c) => {
          const { name, location } = c.req.valid("json")
          // directory comes from the query parameter added by the SDK, not from the body.
          const directory = c.req.query("directory")

          const projectRoot = directory ?? Instance.directory
          const projectSkillsDirs = [
            join(projectRoot, ".merakcode", "skills"),
            join(projectRoot, ".merakcode", "skill"),
          ]
          const externalDirs = [
            join(Global.Path.home, ".claude", "skills"),
            join(Global.Path.home, ".agents", "skills"),
          ]

          const allowedDirs = [...SkillInstall.globalSkillsDirs(), ...projectSkillsDirs, ...externalDirs]
          const skillDir = resolveSkillInstallRoot(location, allowedDirs)
          if (!skillDir) {
            return c.json({ error: "Invalid skill location" }, 403)
          }

          try {
            await rm(skillDir, { recursive: true, force: true })
            Skill.state.invalidate()
            Command.state.invalidate()
            // Tell clients to reload the command list so the removed skill leaves the slash menu.
            void Bus.publish(Config.UpdatedEvent, {})
            return c.json({ name, deleted: true })
          } catch (e) {
            const msg = e instanceof Error ? e.message : "Failed to delete skill"
            return c.json({ error: msg }, 400)
          }
        },
      )
      .get(
        "/lsp",
        describeRoute({
          description: "Get LSP server status",
          operationId: "lsp.status",
          responses: {
            200: {
              description: "LSP server status",
              content: {
                "application/json": {
                  schema: resolver(LSP.Status.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          return c.json(await LSP.status())
        },
      )
      .get(
        "/formatter",
        describeRoute({
          summary: "Get formatter status",
          description: "Get formatter status",
          operationId: "formatter.status",
          responses: {
            200: {
              description: "Formatter status",
              content: {
                "application/json": {
                  schema: resolver(Format.Status.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          return c.json(await Format.status())
        },
      )
      .get(
        "/event",
        describeRoute({
          summary: "Subscribe to events",
          description: "Get events",
          operationId: "event.subscribe",
          responses: {
            200: {
              description: "Event stream",
              content: {
                "text/event-stream": {
                  schema: resolver(BusEvent.payloads()),
                },
              },
            },
          },
        }),
        async (c) => {
          log.info("event connected")
          return streamSSE(c, async (stream) => {
            await EventStream.run({
              stream,
              subscribe: Bus.subscribeAll,
              connected: {
                type: "server.connected",
                properties: {},
              },
              heartbeat: {
                type: "server.heartbeat",
                properties: {},
              },
              close: (event) => event.type === Bus.InstanceDisposed.type,
              onClose: () => log.info("event disconnected"),
            })
          })
        },
      )

    // Extra routes must come before the static asset / SPA fallback, which ends every request it matches.
    const extended = extend ? extend(routed) : routed

    return extended.use("/*", async (c, next) => {
      const dev = devApp()
      if (dev) return c.req.method === "GET" || c.req.method === "HEAD" ? AppDev.forward(c.req.raw, dev) : next()
      const dist = await Server.appDist()
      if (!dist) return next()
      const reqPath = decodeURIComponent(new URL(c.req.url).pathname)
      if (typeof dist !== "string") {
        const key = reqPath.replace(/^\/+/, "")
        const asset = dist[key]
        if (asset) {
          return new Response(fileStream(asset), {
            headers: appAssetHeaders(resolveAssetContentType(key, Filesystem.mimeType(asset))),
          })
        }
        // A missing WASM/JS asset must 404, not fall back to index.html, or the terminal compiles HTML as WASM.
        if (isFrontendStaticAssetPath(reqPath)) return new Response("Not Found", { status: 404 })
        const indexAsset = dist["index.html"]
        if (indexAsset) {
          return new Response(fileStream(indexAsset), {
            headers: appAssetHeaders("text/html; charset=utf-8"),
          })
        }
        return next()
      }
      const abs = resolve(dist, "." + reqPath)
      const rel = relative(dist, abs)
      if (rel.startsWith("..") || rel.startsWith(sep + "..")) return next()
      if ((await Filesystem.isFile(abs)) && !abs.endsWith(sep)) {
        return new Response(fileStream(abs), {
          headers: appAssetHeaders(resolveAssetContentType(reqPath, Filesystem.mimeType(abs))),
        })
      }
      if (isFrontendStaticAssetPath(reqPath)) return new Response("Not Found", { status: 404 })
      // SPA fallback: only frontend routes without an extension get index.html.
      const index = join(dist, "index.html")
      if (await Filesystem.isFile(index)) {
        return new Response(fileStream(index), {
          headers: appAssetHeaders("text/html; charset=utf-8"),
        })
      }
      return next()
    }) as unknown as Hono
  }

  export const App = lazy(() => compose(new Hono()))

  const devApp = lazy(() => {
    const url = AppDev.url()
    if (url) log.info("forwarding UI requests to the dev server", { url: url.href })
    else if (process.env.MERAKCODE_APP_DEV_URL)
      log.warn("ignoring MERAKCODE_APP_DEV_URL: only http on a loopback address is accepted")
    return url
  })

  export async function openapi() {
    // Cast to break excessive type recursion from long route chains
    const result = await generateSpecs(compose(new Hono()) as Hono, {
      documentation: {
        info: {
          title: "merakcode",
          version: enginePackage.version,
          description: "merakcode api",
        },
        openapi: "3.1.1",
      },
    })
    // Model ids in the config are plain provider/model strings. The schema is for editor completion.
    // In the API a model is a plain string (custom provider models are valid too), and generating the SDK must not
    // fetch external documents.
    return JSON.parse(
      JSON.stringify(result, (_key, value) => {
        if (!value || typeof value !== "object" || typeof value.$ref !== "string" || value.$ref.startsWith("#"))
          return value
        const { $ref: _, ...rest } = value
        return rest
      }),
    ) as typeof result
  }

  let _appDist: string | undefined | null = undefined
  let _appDistFiles: Record<string, string> | undefined

  /**
   * Injection point for the session UI files compiled into the binary (relative path -> embedded file path, as
   * returned by `import x from "..." with { type: "file" }`). Generated and injected by the CLI entry. Without it there
   * is no embedded UI, and `appDist()` falls back to `MERAKCODE_APP_DIST` and the `app-dist` directory next to the
   * binary.
   */
  export function configureEmbeddedAppDist(files: Record<string, string> | undefined) {
    _appDistFiles = files
    _appDist = undefined
  }

  async function embeddedAppDist() {
    return _appDistFiles
  }

  export async function appDist(): Promise<string | Record<string, string> | undefined> {
    if (_appDist !== undefined) return _appDist ?? undefined
    // The desktop app points MERAKCODE_APP_DIST at apps/desktop/renderer/dist; it must win over the embedded UI.
    if (process.env.MERAKCODE_APP_DIST) {
      const dir = resolve(process.env.MERAKCODE_APP_DIST)
      if (existsSync(join(dir, "index.html"))) {
        _appDist = dir
        return dir
      }
    }
    const embedded = await embeddedAppDist()
    if (embedded) return embedded
    const execDirs = [dirname(process.execPath), dirname(realpathSync(process.execPath))]
    const candidates = [
      ...execDirs.flatMap((dir) => [
        resolve(dir, "app-dist"), // next to the compiled binary (offline install)
        resolve(dir, "../app-dist"), // global npm install: the real binary is in the package's bin/
      ]),
      resolve(import.meta.dirname, "app-dist"), // flat install (binary next to app-dist)
      resolve(import.meta.dirname, "../app-dist"), // binary in a bin/ subdirectory (tgz layout)
      resolve(import.meta.dirname, "../../app-dist"),
      // In development the CLI entry sets MERAKCODE_APP_DIST; the engine never searches the repository itself.
    ]
    for (const dir of candidates) {
      if (existsSync(join(dir, "index.html"))) {
        _appDist = dir
        return dir
      }
    }
    _appDist = null
    return undefined
  }

  export async function listen(opts: {
    /** 0 lets the system pick. When omitted, 4096 (the merak serve default) is tried first, then the system picks */
    port?: number
    hostname: string
    mdns?: boolean
    mdnsDomain?: string
    cors?: string[]
  }) {
    Flag.seal()
    if (!getLocalSecret()) {
      log.warn("MERAKCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    _corsWhitelist = opts.cors ?? []

    const appFetch = App().fetch
    const server = (opts.port === undefined ? ((await bind(4096)) ?? (await bind(0))) : await bind(opts.port)) as
      Listener | undefined
    if (!server) throw new Error(`Failed to start server on port ${opts.port ?? 4096}`)

    function bind(port: number) {
      return new Promise<Listener | undefined>((resolve) => {
        const sockets = new WebSocketServer({ noServer: true })
        const http = serve({
          hostname: opts.hostname,
          port,
          websocket: { server: sockets },
          fetch: (req, env) => {
            const socket = env.incoming?.socket
            const peer = socket?.remoteAddress
              ? { address: socket.remoteAddress, port: socket.remotePort ?? 0, family: socket.remoteFamily }
              : undefined
            return runWithPeer(peer, () => appFetch(req, env))
          },
        }) as HttpServer
        // The event stream (SSE) and terminals are long-lived connections, so there is no request timeout.
        http.requestTimeout = 0
        // Track connections so a forced stop can close them: closeAllConnections misses upgraded WebSocket ones.
        const connections = Http.track(http)
        http.once("error", (err) => {
          log.warn(`Failed to bind on port ${port}`, { error: err.message })
          sockets.close()
          resolve(undefined)
        })
        http.once("listening", () => {
          const address = http.address() as AddressInfo
          const host = opts.hostname.includes(":") ? `[${opts.hostname}]` : opts.hostname
          resolve({
            url: new URL(`http://${host}:${address.port}`),
            hostname: opts.hostname,
            port: address.port,
            stop: (closeActiveConnections) => {
              for (const client of sockets.clients) closeActiveConnections ? client.terminate() : client.close()
              sockets.close()
              return Http.close(http, connections, closeActiveConnections)
            },
          })
        })
      })
    }

    _url = server.url
    ServerAddress.set(server.url)
    // An already set up sandbox is prepared before the first command. Setup itself still waits for the user.
    await Sandbox.wake().catch((error) => log.warn("sandbox wake failed", { error }))
    ConfigWatch.initGlobal()
    SkillWatch.initGlobal()
    RuleWatch.initGlobal()
    const shouldPublishMDNS =
      opts.mdns &&
      server.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (shouldPublishMDNS) {
      MDNS.publish(server.port, opts.mdnsDomain)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    return {
      ...server,
      stop: async (closeActiveConnections?: boolean) => {
        const stopping = server.stop(closeActiveConnections)
        if (shouldPublishMDNS) MDNS.unpublish()
        Provider.invalidateAll()
        await stopping
      },
    }
  }

  /** A listening server. stop(true) closes open connections at once; stop() waits for open requests to finish */
  export type Listener = {
    readonly url: URL
    readonly hostname: string
    readonly port: number
    stop(closeActiveConnections?: boolean): Promise<void>
  }
}
