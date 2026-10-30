import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import z from "zod"
import { Plugin } from "../../../agent/plugin"
import { lazy } from "@merakcode/util/lazy"

const Info = z.object({
  id: z.string(),
  spec: z.string(),
  source: z.enum(["internal", "config"]),
  status: z.enum(["active", "degraded", "failed"]),
  error: z.string().optional(),
  tools: z.array(z.string()),
})

const Scope = {
  scope: z
    .enum(["project", "global"])
    .optional()
    .meta({ description: "Which config file to change (default project)" }),
}

export const PluginRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List plugins",
        description: "List built-in and configured plugins with their runtime health and registered tools.",
        operationId: "plugin.list",
        responses: {
          200: {
            description: "Plugin runtime status",
            content: {
              "application/json": {
                schema: resolver(z.array(Info)),
              },
            },
          },
        },
      }),
      async (c) => c.json(await Plugin.statuses()),
    )
    .post(
      "/",
      describeRoute({
        summary: "Add plugin",
        description:
          "Add a plugin specifier to the project (or global) config file. An existing plugin with the same name is replaced.",
        operationId: "plugin.add",
        responses: {
          200: { description: "Plugin added", content: { "application/json": { schema: resolver(z.boolean()) } } },
        },
      }),
      validator("json", z.object({ specifier: z.string().min(1), ...Scope })),
      async (c) => {
        await Plugin.add(c.req.valid("json"))
        return c.json(true)
      },
    )
    .delete(
      "/",
      describeRoute({
        summary: "Remove plugin",
        description:
          "Remove a plugin from the project (or global) config file by name or full specifier. Returns false when it is not configured there.",
        operationId: "plugin.remove",
        responses: {
          200: {
            description: "Whether the plugin was removed",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
        },
      }),
      validator("query", z.object({ name: z.string().min(1), ...Scope })),
      async (c) => c.json(await Plugin.remove(c.req.valid("query"))),
    ),
)
