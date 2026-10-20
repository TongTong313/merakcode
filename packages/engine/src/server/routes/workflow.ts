import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import z from "zod"
import { WorkflowState } from "../../workflow/state"
import { WorkflowPartSync } from "../../workflow/part-sync"
import { WorkflowRunRecord } from "../../workflow/types"
import { lazy } from "../../util/lazy"

export const WorkflowRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List workflow runs",
        description: "List dynamic workflow runs for a session.",
        operationId: "workflow.list",
        responses: {
          200: {
            description: "Workflow runs",
            content: {
              "application/json": {
                schema: resolver(z.array(WorkflowRunRecord)),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          sessionID: z.string(),
        }),
      ),
      async (c) => {
        const { sessionID } = c.req.valid("query")
        const runs = await WorkflowState.listRuns(sessionID)
        // Fallback: copy finished runs whose message part is still stuck in running back into the part. reconcile
        // skips finished records and subscribers no longer emit events for them, so only this can repair stuck
        // sessions and crash windows. Idempotent; the runs themselves are not changed.
        await WorkflowPartSync.syncRuns(runs)
        return c.json(runs)
      },
    )
    .get(
      "/:sessionID/:runId",
      describeRoute({
        summary: "Get workflow run",
        description: "Get a dynamic workflow run.",
        operationId: "workflow.get",
        responses: {
          200: {
            description: "Workflow run",
            content: {
              "application/json": {
                schema: resolver(WorkflowRunRecord),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
          runId: z.string(),
        }),
      ),
      async (c) => {
        const { sessionID, runId } = c.req.valid("param")
        const run = await WorkflowState.readRun(sessionID, runId)
        if (!run) return c.json(undefined, 404)
        return c.json(run)
      },
    )
    .post(
      "/:sessionID/:runId/cancel",
      describeRoute({
        summary: "Cancel workflow run",
        description: "Cancel a running dynamic workflow run.",
        operationId: "workflow.cancel",
        responses: {
          200: {
            description: "Whether the workflow run was found and cancelled",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
          runId: z.string(),
        }),
      ),
      async (c) => {
        const { sessionID, runId } = c.req.valid("param")
        return c.json(await WorkflowState.cancelRun(sessionID, runId))
      },
    ),
)
