import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import z from "zod"
import { PermissionNext } from "../../permission/next"
import { Identifier } from "@merakcode/util/id"
import { Session } from "../../session"
import { Config } from "../../config/config"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const PermissionRoutes = lazy(() =>
  new Hono()
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Respond to permission request",
        description:
          "Approve or deny a permission request from the AI assistant. `session` allows it for the rest of the session (shared with subagents), `always` also saves the rule to the project config; `scope` picks the grant (file, directory, command prefix, domain, ...).",
        operationId: "permission.reply",
        responses: {
          200: {
            description: "Permission processed successfully",
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
          requestID: z.string(),
        }),
      ),
      validator("json", PermissionNext.ReplyInput.omit({ requestID: true })),
      async (c) => {
        const input = { ...c.req.valid("json"), requestID: c.req.valid("param").requestID }
        await PermissionNext.reply(input)
        return c.json(true)
      },
    )
    .get(
      "/",
      describeRoute({
        summary: "List pending permissions",
        description: "Get all pending permission requests across all sessions.",
        operationId: "permission.list",
        responses: {
          200: {
            description: "List of pending permissions",
            content: {
              "application/json": {
                schema: resolver(PermissionNext.Request.array()),
              },
            },
          },
        },
      }),
      async (c) => c.json(await PermissionNext.list()),
    )
    .get(
      "/grant",
      describeRoute({
        summary: "List session grants",
        description:
          "Rules the user allowed for the rest of a session (shared with its subagents). Pass any session of the tree; the grants of its main session are returned.",
        operationId: "permission.grants",
        responses: {
          200: {
            description: "Session grants",
            content: { "application/json": { schema: resolver(PermissionNext.Rule.array()) } },
          },
        },
      }),
      validator("query", z.object({ sessionID: Identifier.schema("session") })),
      async (c) => {
        const root = await Session.rootID(c.req.valid("query").sessionID)
        return c.json(await PermissionNext.grants(root))
      },
    )
    .get(
      "/rule",
      describeRoute({
        summary: "List permission rules",
        description:
          "Rules written in the project config (.merakcode/merakcode.json) and the global config, separately.",
        operationId: "permission.rules",
        responses: {
          200: {
            description: "Rules by config file",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({ project: PermissionNext.Rule.array(), global: PermissionNext.Rule.array() }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        // List patterns exactly as written in the file (~ is not expanded), so deleting by the same key finds them.
        const raw = (permission: Config.Permission = {}) =>
          Object.entries(permission).flatMap(([key, value]) =>
            Object.entries(typeof value === "string" ? { "*": value } : value).map(([pattern, action]) => ({
              permission: key,
              pattern,
              action,
            })),
          )
        return c.json({
          project: raw((await Config.loadProjectMerakCodeFile()).permission),
          global: raw((await Config.loadGlobalMerakCodeFile()).permission),
        })
      },
    )
    .post(
      "/rule",
      describeRoute({
        summary: "Set a permission rule",
        description:
          "Add, change or (without action) remove one rule in the project or global config: permission key, pattern (path, command prefix like `npm test *`, domain) and action.",
        operationId: "permission.rule",
        responses: {
          200: { description: "Saved", content: { "application/json": { schema: resolver(z.boolean()) } } },
        },
      }),
      validator(
        "json",
        z.object({
          scope: z.enum(["project", "global"]),
          permission: z.string().min(1),
          pattern: z.string().min(1),
          action: PermissionNext.Action.optional(),
        }),
      ),
      async (c) => {
        const input = c.req.valid("json")
        if (PermissionNext.INTERNAL_PERMISSION_KEYS.has(input.permission))
          return c.json({ message: `${input.permission} is an internal permission` }, 400)
        await Config.setPermissionRule(input)
        return c.json(true)
      },
    )
    .post(
      "/grant/revoke",
      describeRoute({
        summary: "Revoke a session grant",
        description: "Remove one rule the user allowed for the rest of a session; later calls ask again.",
        operationId: "permission.revoke",
        responses: {
          200: { description: "Revoked", content: { "application/json": { schema: resolver(z.boolean()) } } },
        },
      }),
      validator(
        "json",
        z.object({ sessionID: Identifier.schema("session"), permission: z.string(), pattern: z.string() }),
      ),
      async (c) => {
        const { sessionID, ...rule } = c.req.valid("json")
        await PermissionNext.revoke(await Session.rootID(sessionID), rule)
        return c.json(true)
      },
    ),
)
