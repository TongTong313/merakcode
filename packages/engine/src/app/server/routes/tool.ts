import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import z from "zod"
import { RemoteTool } from "../../../agent/tools/remote"
import { errors } from "../error"
import { lazy } from "@merakcode/util/lazy"

/** Remote tools of the SDK host: registration and returning results (see tool/remote.ts) */
export const ToolRoutes = lazy(() =>
  new Hono()
    .put(
      "/remote",
      describeRoute({
        summary: "Register remote tools",
        description:
          "Replace the tools defined in the SDK host. The engine publishes tool.remote.call when the model calls one; the host answers with tool.remote.result.",
        operationId: "tool.remote.register",
        responses: {
          200: { description: "Registered", content: { "application/json": { schema: resolver(z.boolean()) } } },
          ...errors(400),
        },
      }),
      validator("json", z.object({ tools: z.array(RemoteTool.Definition) })),
      async (c) => {
        RemoteTool.set(c.req.valid("json").tools)
        return c.json(true)
      },
    )
    .post(
      "/remote/:callID",
      describeRoute({
        summary: "Return a remote tool result",
        description: "Hand the result (or error) of a remote tool call back to the engine.",
        operationId: "tool.remote.result",
        responses: {
          200: {
            description: "Whether a call was waiting for this result",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ callID: z.string() })),
      validator("json", RemoteTool.Result),
      async (c) => c.json(RemoteTool.settle(c.req.valid("param").callID, c.req.valid("json"))),
    ),
)
