import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import { Bus } from "../../bus"
import { Config } from "../../config/config"
import { McpManagement } from "../../mcp/management"
import { McpManagementContract } from "../../mcp/management-contract"
import { lazy } from "../../util/lazy"
import { errors } from "../error"

export const McpManagementRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Read managed MCP servers",
        description: "Read configuration, runtime status, and tools as one consistent MCP snapshot.",
        operationId: "mcpManagement.read",
        responses: {
          200: {
            description: "Complete MCP management snapshot",
            content: { "application/json": { schema: resolver(McpManagementContract.Snapshot) } },
          },
        },
      }),
      async (c) => c.json(await McpManagement.read()),
    )
    .post(
      "/change",
      describeRoute({
        summary: "Change a managed MCP server",
        description: "Atomically change MCP configuration and runtime state with typed compensation results.",
        operationId: "mcpManagement.change",
        responses: {
          200: {
            description: "MCP management result",
            content: { "application/json": { schema: resolver(McpManagementContract.Result) } },
          },
          ...errors(400),
        },
      }),
      validator("json", McpManagementContract.Command),
      async (c) => {
        const result = await McpManagement.change(c.req.valid("json"))
        // Like skill installs: tell clients to refresh MCP status (global-sync loadMcp, then the Safety tool hints).
        if (result.ok) void Bus.publish(Config.UpdatedEvent, {})
        return c.json(result)
      },
    ),
)
