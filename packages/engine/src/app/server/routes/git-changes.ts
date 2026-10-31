import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { GitChanges } from "../../project/git-changes"
import { lazy } from "@merakcode/util/lazy"
import { validator } from "../validator"
import { errors } from "../error"

export const GitChangesRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get Git changes",
        description:
          "List staged and unstaged files from Git, independently of conversation review. A file may appear in both groups.",
        operationId: "vcs.changes.get",
        responses: {
          200: { description: "Git changes", content: { "application/json": { schema: resolver(GitChanges.Result) } } },
          ...errors(400, 409),
        },
      }),
      async (c) => c.json(await GitChanges.get()),
    )
    .post(
      "/stage",
      describeRoute({
        summary: "Stage files",
        description:
          "Stage the explicit file versions displayed by vcs.changes.get. Does not change working files or conversation review. Stale versions or checkout contexts fail before writing.",
        operationId: "vcs.changes.stage",
        responses: {
          200: {
            description: "Updated Git changes",
            content: { "application/json": { schema: resolver(GitChanges.Result) } },
          },
          ...errors(400, 409),
        },
      }),
      validator("json", GitChanges.Input),
      async (c) => c.json(await GitChanges.stage(c.req.valid("json"))),
    )
    .post(
      "/unstage",
      describeRoute({
        summary: "Unstage files",
        description:
          "Remove the explicit displayed files from the next commit while preserving working files and review state. Also works before the first commit.",
        operationId: "vcs.changes.unstage",
        responses: {
          200: {
            description: "Updated Git changes",
            content: { "application/json": { schema: resolver(GitChanges.Result) } },
          },
          ...errors(400, 409),
        },
      }),
      validator("json", GitChanges.Input),
      async (c) => c.json(await GitChanges.unstage(c.req.valid("json"))),
    ),
)
