import { failure } from "@merakcode/log"
import { Hono } from "hono"
import { stream } from "hono/streaming"
import { describeRoute, resolver } from "hono-openapi"
import { reject, validator } from "../validator"
import z from "zod"
import { Session } from "../../session"
import { Message } from "../../session/message"
import { Transcript } from "../../session/transcript"
import { SessionRunner } from "../../session/runner"
import { SessionDispatch } from "../../session/dispatch"
import { SessionCompaction } from "../../session/compaction"
import { SessionRevert } from "../../session/revert"
import { SessionUndoRedo } from "../../session/undo-redo"
import { SessionStatus } from "../../session/status"
import { SessionSummary } from "../../session/summary"
import { Todo } from "../../session/todo"
import { SessionNotificationDelivery } from "../../session/notification-delivery"
import { Agent } from "../../agent/agent"
import { Snapshot } from "../../snapshot"
import { Log } from "@merakcode/log/logger"
import { Text } from "../../util/text"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Bus } from "../../bus"
import { Filesystem } from "@merakcode/util/filesystem"
import { NamedError } from "@merakcode/util/error"
import { Storage } from "../../storage/storage"
import { Instance } from "../../project/instance"
import { Identifier } from "@merakcode/util/id"

const log = Log.create({ service: "server" })

export const SessionRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List sessions",
        description: "Get a list of all MerakCode sessions, sorted by most recently updated.",
        operationId: "session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Filter sessions by project directory" }),
          roots: z.coerce.boolean().optional().meta({ description: "Only return root sessions (no parentID)" }),
          start: z.coerce
            .number()
            .optional()
            .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const term = query.search?.toLowerCase()
        const sessions: Session.Info[] = []
        // Session.list is already bucketed by Instance.project.id. Filtering by directory only makes sense for
        // single-folder/git projects (several sandboxes in one project). A workspace keeps a stable identity while its
        // primary folder may change, and session.directory is still the primary at creation, so filtering by
        // directory would hide history.
        const directory = Instance.project.kind === "workspace" ? undefined : query.directory
        for await (const session of Session.list()) {
          if (directory !== undefined && !Filesystem.sameDirectory(session.directory, directory)) continue
          if (query.roots && session.parentID) continue
          if (query.start !== undefined && session.time.updated < query.start) continue
          if (term !== undefined && !session.title.toLowerCase().includes(term)) continue
          sessions.push(session)
          if (query.limit !== undefined && sessions.length >= query.limit) break
        }
        return c.json(sessions)
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get session status",
        description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
        operationId: "session.status",
        responses: {
          200: {
            description: "Get session status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), SessionStatus.Info)),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const result = SessionStatus.list()
        return c.json(result)
      },
    )
    .get(
      "/:sessionID",
      describeRoute({
        summary: "Get session",
        description: "Retrieve detailed information about a specific MerakCode session.",
        tags: ["Session"],
        operationId: "session.get",
        responses: {
          200: {
            description: "Get session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.get.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        log.info("SEARCH", { url: c.req.url })
        const session = await Session.get(sessionID)
        SessionNotificationDelivery.request(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/children",
      describeRoute({
        summary: "Get session children",
        tags: ["Session"],
        description: "Retrieve all child sessions that were forked from the specified parent session.",
        operationId: "session.children",
        responses: {
          200: {
            description: "List of children",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.children.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const session = await Session.children(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/todo",
      describeRoute({
        summary: "Get session todos",
        description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
        operationId: "session.todo",
        responses: {
          200: {
            description: "Todo list",
            content: {
              "application/json": {
                schema: resolver(Todo.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const todos = await Todo.get(sessionID)
        return c.json(todos)
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create session",
        description: "Create a new MerakCode session for interacting with AI assistants and managing conversations.",
        operationId: "session.create",
        responses: {
          ...errors(400),
          200: {
            description: "Successfully created session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator("json", Session.create.schema.optional()),
      async (c) => {
        const body = c.req.valid("json") ?? {}
        const session = await Session.create(body)
        return c.json(session)
      },
    )
    .delete(
      "/:sessionID",
      describeRoute({
        summary: "Delete session",
        description: "Delete a session and permanently remove all associated data, including messages and history.",
        operationId: "session.delete",
        responses: {
          200: {
            description: "Successfully deleted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.remove.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.remove(sessionID)
        return c.json(true)
      },
    )
    .patch(
      "/:sessionID",
      describeRoute({
        summary: "Update session",
        description: "Update properties of an existing session, such as title or other metadata.",
        operationId: "session.update",
        responses: {
          200: {
            description: "Successfully updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      // Permission rules are not part of this endpoint: approvals go through permission.reply (once / reject), lasting
      // trust through sandbox approval. The validator would silently strip the undeclared field, so permission is
      // rejected explicitly; otherwise callers would take the 200 as the rules being saved.
      async (c, next) => {
        const body = await c.req.json().catch(() => undefined)
        if (!body || typeof body !== "object" || !("permission" in body)) return next()
        reject([
          {
            path: ["permission"],
            message: await Text.pick({
              zh: "session.update 不支持修改权限规则。单次授权请用 permission.reply，文件访问的持久信任请用沙箱审批",
              en: "session.update cannot change permission rules. Use permission.reply for a one-off approval, and sandbox approval for lasting file-access trust",
            }),
          },
        ])
      },
      validator(
        "json",
        z.object({
          title: z.string().optional(),
          time: z
            .object({
              archived: z.number().optional(),
            })
            .optional(),
          metadata: Session.Info.shape.metadata,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const updates = c.req.valid("json")

        const updatedSession = await Session.update(
          sessionID,
          (session) => {
            if (updates.title !== undefined) {
              session.title = updates.title
            }
            if (updates.time?.archived !== undefined) session.time.archived = updates.time.archived
            // Replaced as a whole, not merged, as in opencode 1.16.2; callers merge old keys themselves.
            if (updates.metadata !== undefined) session.metadata = updates.metadata
          },
          { touch: false },
        )

        return c.json(updatedSession)
      },
    )
    .post(
      "/:sessionID/permission-mode",
      describeRoute({
        summary: "Set session permission mode",
        description:
          "Switch the session's permission mode (read-only, ask, auto) while it runs. Pending approvals are re-evaluated under the new mode and released if now allowed; subagents follow the main session.",
        operationId: "session.setPermissionMode",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", Session.setPermissionMode.schema.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const session = await Session.setPermissionMode({ ...body, sessionID })
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/init",
      describeRoute({
        summary: "Initialize session",
        description:
          "Analyze the current application and create or improve AGENTS.md with project-specific agent instructions. An existing CLAUDE.md may be used as reference when consolidating into AGENTS.md.",
        operationId: "session.init",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", Session.initialize.schema.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        await Session.initialize({ ...body, sessionID })
        return c.json(true)
      },
    )
    .post(
      "/:sessionID/fork",
      describeRoute({
        summary: "Fork session",
        description: "Create a new session by forking an existing session at a specific message point.",
        operationId: "session.fork",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.fork.schema.shape.sessionID,
        }),
      ),
      validator("json", Session.fork.schema.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const result = await Session.fork({ ...body, sessionID })
        return c.json(result)
      },
    )
    .post(
      "/:sessionID/abort",
      describeRoute({
        summary: "Abort session",
        description: "Abort an active session and stop any ongoing AI processing or command execution.",
        operationId: "session.abort",
        responses: {
          200: {
            description: "Aborted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await SessionDispatch.cancel(sessionID)
        return c.json(true)
      },
    )
    .post(
      "/:sessionID/tool/:callID/abort",
      describeRoute({
        summary: "Abort a single tool call",
        description: "Abort a specific in-flight tool call without stopping the entire session.",
        operationId: "session.toolAbort",
        responses: {
          200: {
            description: "Whether the tool call was found and aborted",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
          callID: z.string(),
        }),
      ),
      async (c) => {
        const { sessionID, callID } = c.req.valid("param")
        const ok = SessionRunner.cancelTool(sessionID, callID)
        return c.json(ok)
      },
    )
    .get(
      "/:sessionID/diff",
      describeRoute({
        summary: "Get message diff",
        description: "Get the file changes (diff) that resulted from a specific user message in the session.",
        operationId: "session.diff",
        responses: {
          200: {
            description: "Successfully retrieved diff",
            content: {
              "application/json": {
                schema: resolver(Snapshot.FileDiff.array()),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionSummary.diff.schema.shape.sessionID,
        }),
      ),
      validator(
        "query",
        z.object({
          messageID: SessionSummary.diff.schema.shape.messageID,
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const params = c.req.valid("param")
        const result = await SessionSummary.diff({
          sessionID: params.sessionID,
          messageID: query.messageID,
        })
        return c.json(result)
      },
    )
    .post(
      "/:sessionID/summarize",
      describeRoute({
        summary: "Summarize session",
        description: "Generate a concise summary of the session using AI compaction to preserve key information.",
        operationId: "session.summarize",
        responses: {
          200: {
            description: "Summarized session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          providerID: z.string(),
          modelID: z.string(),
          auto: z.boolean().optional().default(false),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const session = await Session.get(sessionID)
        await SessionRevert.cleanup(session)
        const msgs = await Session.messages({ sessionID })
        let currentAgent: string = await Agent.defaultAgent()
        for (let i = msgs.length - 1; i >= 0; i--) {
          const info = msgs[i].info
          if (info.role === "user") {
            currentAgent = info.agent || (await Agent.defaultAgent())
            break
          }
        }
        await SessionCompaction.create({
          sessionID,
          agent: currentAgent,
          model: {
            providerID: body.providerID,
            modelID: body.modelID,
          },
          auto: body.auto,
        })
        await SessionRunner.loop({ sessionID })
        return c.json(true)
      },
    )
    .get(
      "/:sessionID/message",
      describeRoute({
        summary: "Get session messages",
        description: "Retrieve all messages in a session, including user prompts and AI responses.",
        operationId: "session.messages",
        responses: {
          200: {
            description: "List of messages",
            content: {
              "application/json": {
                schema: resolver(Message.FullMsg.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator(
        "query",
        z.object({
          limit: z.coerce.number().optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const messages = await Session.messages({
          sessionID: c.req.valid("param").sessionID,
          limit: query.limit,
        })
        return c.json(messages)
      },
    )
    .get(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Get message",
        description: "Retrieve a specific message from a session by its message ID.",
        operationId: "session.message",
        responses: {
          200: {
            description: "Message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: Message.Info,
                    parts: Message.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
          messageID: z.string().meta({ description: "Message ID" }),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const message = await Message.get({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        return c.json(message)
      },
    )
    .delete(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Delete message",
        description:
          "Permanently delete a specific message and all of its parts from a session without reverting file changes.",
        operationId: "session.deleteMessage",
        responses: {
          200: {
            description: "Successfully deleted message",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
          messageID: z.string().meta({ description: "Message ID" }),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        // Check the message exists first: Storage.remove succeeds silently for missing keys, so a wrong ID would
        // return true.
        await Message.get({ sessionID: params.sessionID, messageID: params.messageID })
        await Session.removeMessage({ sessionID: params.sessionID, messageID: params.messageID })
        return c.json(true)
      },
    )
    .delete(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Delete a part from a message",
        operationId: "part.delete",
        responses: {
          200: {
            description: "Successfully deleted part",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
          messageID: z.string().meta({ description: "Message ID" }),
          partID: z.string().meta({ description: "Part ID" }),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await Session.removePart({
          sessionID: params.sessionID,
          messageID: params.messageID,
          partID: params.partID,
        })
        return c.json(true)
      },
    )
    .patch(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Update a part in a message",
        operationId: "part.update",
        responses: {
          200: {
            description: "Successfully updated part",
            content: {
              "application/json": {
                schema: resolver(Message.Part),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
          messageID: z.string().meta({ description: "Message ID" }),
          partID: z.string().meta({ description: "Part ID" }),
        }),
      ),
      validator("json", Message.Part),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        if (body.id !== params.partID || body.messageID !== params.messageID || body.sessionID !== params.sessionID) {
          throw new Error(
            `Part mismatch: body.id='${body.id}' vs partID='${params.partID}', body.messageID='${body.messageID}' vs messageID='${params.messageID}', body.sessionID='${body.sessionID}' vs sessionID='${params.sessionID}'`,
          )
        }
        const message = await Message.get({ sessionID: params.sessionID, messageID: params.messageID })
        if (message.info.role === "user" && message.info.commandSource) {
          const current = message.parts.find((part) => part.id === body.id)
          if (!current || current.type !== body.type) {
            return c.json({ error: "Command message parts cannot be added or change type" }, 400)
          }
          const source = message.info.commandSource
          if (body.type === "text" && !body.ignored && !source.templatePartIDs.includes(body.id)) {
            return c.json({ error: "Command text must remain covered by its source IDs" }, 400)
          }
        }
        const part = await Session.updatePart(
          message.info.role === "user" && body.type === "text" ? { ...body, synthetic: undefined } : body,
        )
        return c.json(part)
      },
    )
    .post(
      "/:sessionID/message",
      describeRoute({
        summary: "Send message",
        description: "Create and send a new message to a session, streaming the AI response.",
        operationId: "session.prompt",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: Message.AssistantInfo,
                    parts: Message.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", SessionRunner.PromptInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        // Check the session exists first so NotFound goes through Hono onError as a 404 JSON. A throw inside the
        // stream callback comes after the 200 has started, onError cannot catch it, and the worker's unhandled
        // rejection would be printed to the terminal the TUI is using.
        await Session.get(sessionID)

        c.status(200)
        c.header("Content-Type", "application/json")
        return stream(c, async (out) => {
          try {
            const msg = await SessionDispatch.prompt({ ...body, sessionID })
            out.write(JSON.stringify(msg))
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") return
            log.error("session.prompt stream failed", { sessionID, ...failure(error) })
            // Internal details such as paths go to the log only; the UI gets a generic message.
            Bus.publish(Session.Event.Error, {
              sessionID,
              error: new NamedError.Unknown({
                message: Text.format(
                  { zh: "会话请求未完成，请重新提交。", en: "The session request did not finish. Please resubmit." },
                  await Text.lang(),
                ),
              }).toObject(),
            })
          }
        })
      },
    )
    .post(
      "/:sessionID/prompt_async",
      describeRoute({
        summary: "Send async message",
        description:
          "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
        operationId: "session.prompt_async",
        responses: {
          204: {
            description: "Prompt accepted",
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", SessionRunner.PromptInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        await Session.get(sessionID)
        // Fire and forget: reply 204 (no body) right away.
        // If prompt() throws before producing an assistant message (corrupt message file, a non-allowlisted
        // Provider.getModel error, missing agent, ...), the rejection would be swallowed with neither session.error nor
        // message.updated, and IM clients would hang forever. Publishing it as session.error lets the client end the
        // turn and show the error.
        SessionDispatch.prompt({ ...body, sessionID }).catch((e: any) => {
          if (e?.name === "AbortError") return
          log.error("prompt_async failed before producing a reply", {
            sessionID,
            error: String(e?.stack ?? e?.message ?? e),
          })
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({ message: String(e?.message ?? e) }, { cause: e }).toObject(),
          })
        })
        return c.body(null, 204)
      },
    )
    .post(
      "/:sessionID/command",
      describeRoute({
        summary: "Send command",
        description: "Send a new command to a session for execution by the AI assistant.",
        operationId: "session.command",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: Message.AssistantInfo,
                    parts: Message.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", SessionRunner.CommandInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const msg = await SessionDispatch.command({ ...body, sessionID })
        return c.json(msg)
      },
    )
    .post(
      "/:sessionID/shell",
      describeRoute({
        summary: "Run shell command",
        description: "Execute a shell command within the session context and return the AI's response.",
        operationId: "session.shell",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(Message.AssistantInfo),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", SessionRunner.ShellInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const msg = await SessionRunner.shell({ ...body, sessionID })
        return c.json(msg)
      },
    )
    .post(
      "/:sessionID/revert",
      describeRoute({
        summary: "Revert message",
        description: "Revert a specific message in a session, undoing its effects and restoring the previous state.",
        operationId: "session.revert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      validator("json", SessionUndoRedo.RevertInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        log.info("revert", body)
        const session = await SessionUndoRedo.undo({
          sessionID,
          messageID: body.messageID,
          revertFiles: body.revertFiles,
        })
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/unrevert",
      describeRoute({
        summary: "Restore reverted messages",
        description: "Restore all previously reverted messages in a session.",
        operationId: "session.unrevert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const session = await SessionUndoRedo.redo({ sessionID })
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/export-full",
      describeRoute({
        summary: "Export full session data",
        description:
          "Export the complete session (all metadata and message parts) as JSON, suitable for backup or migration. Unlike the transcript export, no data is omitted.",
        operationId: "session.exportFull",
        responses: {
          200: {
            description: "Full session export",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: Session.Info,
                    messages: Message.FullMsg.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.get.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const info = await Session.get(sessionID)
        const messages = await Session.messages({ sessionID })
        return c.json({ info, messages })
      },
    )
    .post(
      "/import-full",
      describeRoute({
        summary: "Import full session data",
        description:
          "Import a session previously produced by export-full (or the `merak export` CLI command), restoring its full metadata and messages. A brand-new session/message/part ID is generated on import so the operation never merges into or overwrites any existing session; directory/projectID are rewritten to the current project.",
        operationId: "session.importFull",
        responses: {
          200: {
            description: "Imported session",
            content: {
              "application/json": {
                schema: resolver(z.object({ info: Session.Info })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", ImportFullBody(), async (result, c) => {
        if (result.success) return
        // Files exported by older versions may contain error names since removed from the union: map them as on
        // read and validate again.
        const retry = ImportFullBody().safeParse(legacyExport(result.data))
        if (retry.success) return c.json(await importFull(retry.data))
        reject(result.error)
      }),
      async (c) => c.json(await importFull(c.req.valid("json"))),
    ),
)

// Must be lazy: this module and session/index import each other, and some entry points (such as the sandbox worker)
// load this module before Session is initialized.
const ImportFullBody = lazy(() =>
  z.object({
    info: Session.Info,
    messages: Message.FullMsg.array(),
  }),
)

function legacyExport(data: unknown) {
  const body = data as { messages?: { info?: Message.Info }[] } | undefined
  if (!Array.isArray(body?.messages)) return data
  return {
    ...body,
    messages: body.messages.map((item) => (item?.info ? { ...item, info: Message.legacy(item.info) } : item)),
  }
}

async function importFull(body: z.infer<ReturnType<typeof ImportFullBody>>) {
  // An import always generates new session/message/part IDs and never reuses the exported ones: keeping the old
  // session ID would merge into an existing session instead of creating one, and its message count would grow.
  const newSessionID = Identifier.descending("session")
  const info: Session.Info = {
    ...body.info,
    id: newSessionID,
    directory: Instance.directory,
    projectID: Instance.project.id,
    // The parent is most likely not in the target project. Keeping parentID would make isChildToolSession treat the
    // import as a child session (no nested subagents, permission mode following a missing parent).
    parentID: undefined,
  }

  const messageIDMap = new Map<string, string>()
  for (const fullMsg of body.messages) {
    messageIDMap.set(fullMsg.info.id, Identifier.ascending("message"))
  }

  const lines = body.messages.flatMap((fullMsg): Transcript.Line[] => {
    const newMessageID = messageIDMap.get(fullMsg.info.id)!
    const parts = fullMsg.parts.map((part) => ({
      ...part,
      id: Identifier.ascending("part"),
      sessionID: newSessionID,
      messageID: newMessageID,
      // A full export is public input. Without trusted command provenance, a
      // synthetic user text would reach the model but be hidden from path guards.
      ...(fullMsg.info.role === "user" && !fullMsg.info.commandSource && part.type === "text"
        ? { synthetic: undefined }
        : {}),
    }))
    // Never trust imported template IDs: cover every model-visible user text
    // (and subtask prompt) after assigning the new part IDs.
    const commandSource =
      fullMsg.info.role === "user" && fullMsg.info.commandSource
        ? {
            templatePartIDs: parts
              .filter((part) => (part.type === "text" && !part.ignored) || part.type === "subtask")
              .map((part) => part.id),
          }
        : undefined
    const newMessageInfo: Message.Info = {
      ...fullMsg.info,
      id: newMessageID,
      sessionID: newSessionID,
      ...(fullMsg.info.role === "user" ? { commandSource } : {}),
      // An assistant message links to the user message it answers through parentID. Map it to the new ID, or the
      // turn breaks apart in the UI because parentID points to an old ID that no longer exists.
      ...(fullMsg.info.role === "assistant"
        ? { parentID: messageIDMap.get(fullMsg.info.parentID) ?? fullMsg.info.parentID }
        : {}),
    }
    return [
      { type: "message", info: newMessageInfo },
      ...parts.map((part): Transcript.Line => ({
        type: "part",
        part,
      })),
    ]
  })

  // Write the whole transcript before the session index, so a failure halfway never leaves a visible but incomplete
  // session.
  await Transcript.create(newSessionID, lines)
  await Storage.write(["session", Instance.project.id, info.id], info)

  Bus.publish(Session.Event.Updated, { sessionID: info.id, info })

  return { info }
}
