import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import { Review } from "../../review"
import { lazy } from "../../util/lazy"

// Review is read lazily: engine modules import each other, so Review may not be initialized at module load.
const failures = () => ({
  400: {
    description: "The scope does not support this decision, or a required parameter is missing",
    content: { "application/json": { schema: resolver(Review.InvalidError.Schema) } },
  },
  409: {
    description: "The file or hunk is no longer in the review (the list is stale); fetch it again",
    content: { "application/json": { schema: resolver(Review.StaleError.Schema) } },
  },
})

export const ReviewRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get review",
        description:
          "List the files changed in a review scope, with line and hunk counts and a version per file: the agent's changes in a session or one turn, unstaged or staged git changes, or the branch against its base. Hunks come from review.file.",
        operationId: "review.get",
        responses: {
          200: { description: "Review", content: { "application/json": { schema: resolver(Review.Result) } } },
          400: failures()[400],
          409: failures()[409],
        },
      }),
      validator("query", Review.Input),
      async (c) => c.json(await Review.get(c.req.valid("query"))),
    )
    .get(
      "/file",
      describeRoute({
        summary: "Get review file",
        description:
          "Hunks of one file in a review scope, with the full base and current text when the file is small enough. Pass the version from review.get; when the file has changed since, the request fails with 409.",
        operationId: "review.file",
        responses: {
          200: {
            description: "File hunks",
            content: { "application/json": { schema: resolver(Review.Detail) } },
          },
          400: failures()[400],
          409: failures()[409],
        },
      }),
      validator("query", Review.FileInput),
      async (c) => c.json(await Review.file(c.req.valid("query"))),
    )
    .post(
      "/",
      describeRoute({
        summary: "Decide review",
        description:
          "Accept or reject whole files or single hunks. Accepting moves the baseline (stages the hunk for unstaged changes); rejecting writes the reverted content back. Returns the updated review.",
        operationId: "review.decide",
        responses: {
          200: { description: "Updated review", content: { "application/json": { schema: resolver(Review.Result) } } },
          ...failures(),
        },
      }),
      validator("json", Review.Decision),
      async (c) => c.json(await Review.decide(c.req.valid("json"))),
    )
    .post(
      "/undo",
      describeRoute({
        summary: "Undo review decision",
        description:
          "Undo the most recent decision in a review scope. Fails with 409 when there is nothing to undo or the files changed after the decision.",
        operationId: "review.undo",
        responses: {
          200: { description: "Updated review", content: { "application/json": { schema: resolver(Review.Result) } } },
          ...failures(),
        },
      }),
      validator("json", Review.Input),
      async (c) => c.json(await Review.undo(c.req.valid("json"))),
    ),
)
