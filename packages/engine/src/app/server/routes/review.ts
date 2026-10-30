import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { validator } from "../validator"
import { Review } from "../../../agent/session/review"
import { Checkout } from "../../../infra/project/checkout"
import { lazy } from "@merakcode/util/lazy"

// Review is read lazily: engine modules import each other, so Review may not be initialized at module load.
const failures = () => ({
  400: {
    description: "The scope does not support this decision, or a required parameter is missing",
    content: { "application/json": { schema: resolver(Review.InvalidError.Schema) } },
  },
  409: {
    description: "The checkout context, file or hunk is stale, or the checkout is switching; fetch the review again",
    content: {
      "application/json": {
        schema: resolver(z.union([Review.StaleError.Schema, Checkout.StaleError.Schema, Checkout.BlockedError.Schema])),
      },
    },
  },
})

export const ReviewRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get review",
        description:
          "List pending agent changes in a conversation or turn, with counts, file versions and the most recent undoable decision. Hunks come from review.file. Git state is managed separately by vcs.changes.",
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
          "Hunks of one file in a review scope, with the full base and current text when the file is small enough. Pass the version and expectedCheckout from review.get; a changed file or checkout context fails with 409.",
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
          "Accept or reject whole files or single hunks. Pass expectedCheckout from review.get; a changed checkout context fails with 409 before writing. Pass explicit files with their displayed versions. Accepting advances the review baseline; rejecting restores working files only. Neither operation changes the Git index or commit history. Returns the updated review.",
        operationId: "review.decide",
        responses: {
          200: { description: "Updated review", content: { "application/json": { schema: resolver(Review.Result) } } },
          ...failures(),
        },
      }),
      validator("json", z.object(Review.Decision.shape)),
      async (c) => c.json(await Review.decide(c.req.valid("json"))),
    )
    .post(
      "/undo",
      describeRoute({
        summary: "Undo review decision",
        description:
          "Undo the most recent decision in a review scope. Pass expectedCheckout from review.get. Fails with 409 when the checkout context changed, there is nothing to undo or the files changed after the decision.",
        operationId: "review.undo",
        responses: {
          200: { description: "Updated review", content: { "application/json": { schema: resolver(Review.Result) } } },
          ...failures(),
        },
      }),
      validator("json", z.object(Review.UndoInput.shape)),
      async (c) => c.json(await Review.undo(c.req.valid("json"))),
    ),
)
