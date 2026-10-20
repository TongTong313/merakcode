import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import z from "zod"
import { MCP } from "../../mcp"
import { Config } from "../../config/config"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Instance } from "../../project/instance"

const selections = new Map<string, Promise<void>>()

function select(name: string, change: () => Promise<void>): Promise<void> {
  const key = `${Instance.directory}\0${name}`
  const task = (selections.get(key) ?? Promise.resolve()).then(change)
  const settled = task.then(
    () => {},
    () => {},
  )
  selections.set(key, settled)
  void settled.then(() => {
    if (selections.get(key) === settled) selections.delete(key)
  })
  return task
}

export const McpRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get MCP status",
        description: "Get the status of all Model Context Protocol (MCP) servers.",
        operationId: "mcp.status",
        responses: {
          200: {
            description: "MCP server status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Status)),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await MCP.status())
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Add MCP server",
        description: "Dynamically add a new Model Context Protocol (MCP) server to the system.",
        operationId: "mcp.add",
        responses: {
          200: {
            description: "MCP server added successfully",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Status)),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          name: z.string(),
          config: Config.Mcp,
        }),
      ),
      async (c) => {
        const { name, config } = c.req.valid("json")
        const result = await MCP.add(name, config)
        return c.json(result.status)
      },
    )
    .post(
      "/:name/connect",
      describeRoute({
        description: "Connect an MCP server",
        operationId: "mcp.connect",
        responses: {
          200: {
            description: "MCP server connected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => {
        const { name } = c.req.valid("param")
        await select(name, async () => {
          await MCP.connect(name)
          if ((await MCP.status())[name]?.status !== "connected") throw new Error("MCP connection failed")
        })
        return c.json(true)
      },
    )
    .post(
      "/:name/disconnect",
      describeRoute({
        description: "Disconnect an MCP server",
        operationId: "mcp.disconnect",
        responses: {
          200: {
            description: "MCP server disconnected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => {
        const { name } = c.req.valid("param")
        await select(name, async () => {
          await MCP.disconnect(name)
        })
        return c.json(true)
      },
    )
    .post(
      "/:name/auth",
      describeRoute({
        summary: "Start MCP OAuth",
        description: "Start OAuth authentication flow for a remote MCP server.",
        operationId: "mcp.auth.start",
        responses: {
          200: {
            description: "OAuth flow started",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({ authorizationUrl: z.string(), oauthState: z.string() }).meta({ ref: "McpAuthStart" }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => c.json(await MCP.startAuth(c.req.valid("param").name)),
    )
    .post(
      "/:name/auth/callback",
      describeRoute({
        summary: "Complete MCP OAuth",
        description: "Complete OAuth for a remote MCP server using the authorization code.",
        operationId: "mcp.auth.callback",
        responses: {
          200: {
            description: "OAuth authentication completed",
            content: { "application/json": { schema: resolver(MCP.Status) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      validator("json", z.object({ code: z.string() })),
      async (c) => {
        const { name } = c.req.valid("param")
        const { code } = c.req.valid("json")
        return c.json(await MCP.finishAuth(name, code))
      },
    )
    .post(
      "/:name/auth/wait",
      describeRoute({
        summary: "Wait for MCP OAuth",
        description:
          "Wait for the browser callback of an OAuth flow started with mcp.auth.start (up to 5 minutes), then exchange the code and connect. Lets the client show and open the authorization URL itself.",
        operationId: "mcp.auth.wait",
        responses: {
          200: {
            description: "OAuth authentication completed",
            content: { "application/json": { schema: resolver(MCP.Status) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      validator("json", z.object({ state: z.string() })),
      async (c) => c.json(await MCP.waitAuth(c.req.valid("param").name, c.req.valid("json").state)),
    )
    .delete(
      "/:name/auth",
      describeRoute({
        summary: "Remove MCP OAuth",
        description: "Remove stored OAuth credentials for an MCP server.",
        operationId: "mcp.auth.remove",
        responses: {
          200: {
            description: "OAuth credentials removed",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.literal(true) }).meta({ ref: "McpAuthRemove" })),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => c.json(await MCP.removeAuth(c.req.valid("param").name)),
    )
    .delete(
      "/:name",
      describeRoute({
        summary: "Delete MCP server",
        description: "Remove an MCP server from config and clean up its runtime connection.",
        operationId: "mcp.remove",
        responses: {
          200: {
            description: "MCP server removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ name: z.string() })),
      validator("query", z.object({ scope: z.enum(["project", "global"]).optional() })),
      async (c) => {
        const { name } = c.req.valid("param")
        const { scope } = c.req.valid("query")
        await select(name, async () => {
          await MCP.disconnect(name)
          await Config.deleteMcpServer(name, scope ?? "global")
        })
        return c.json(true)
      },
    ),
)
