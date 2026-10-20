import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import z from "zod"
import { BashJobStore } from "../../tool/bash-background"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const BashRoutes = lazy(() =>
  new Hono().post(
    "/jobs/:id/stop",
    describeRoute({
      summary: "Stop a background job",
      description: "Send SIGTERM to a running background bash job.",
      operationId: "bash.jobStop",
      responses: {
        200: {
          description: "Whether the job was found and stopped",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(404),
      },
    }),
    validator("param", z.object({ id: z.string() })),
    async (c) => {
      const ok = await BashJobStore.stop(c.req.valid("param").id)
      return c.json(ok)
    },
  ),
)
