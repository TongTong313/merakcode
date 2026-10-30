import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { describeRoute } from "hono-openapi"
import { validator } from "../validator"
import { resolver } from "hono-openapi"
import { Question } from "../../../agent/session/question"
import z from "zod"
import { errors } from "../error"
import { lazy } from "@merakcode/util/lazy"

function questionError(error: unknown): never {
  if (error instanceof Question.InvalidReplyError || error instanceof Question.NotDismissibleError)
    throw new HTTPException(400, { message: error.message })
  if (error instanceof Question.RequestNotFoundError) throw new HTTPException(404, { message: error.message })
  throw error
}

export const QuestionRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List pending questions",
        description: "Get all pending question requests across all sessions.",
        operationId: "question.list",
        responses: {
          200: {
            description: "List of pending questions",
            content: {
              "application/json": {
                schema: resolver(Question.Request.array()),
              },
            },
          },
        },
      }),
      async (c) => c.json(await Question.list()),
    )
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Reply to question request",
        description: "Provide answers to a question request from the AI assistant.",
        operationId: "question.reply",
        responses: {
          200: {
            description: "Question answered successfully",
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
      validator("json", Question.Reply),
      async (c) => {
        const params = c.req.valid("param")
        const json = c.req.valid("json")
        const input = { requestID: params.requestID, answers: json.answers }
        try {
          if (!(await Question.reply(input))) throw new Question.RequestNotFoundError()
        } catch (error) {
          questionError(error)
        }
        return c.json(true)
      },
    )
    .post(
      "/:requestID/reject",
      describeRoute({
        summary: "Reject question request",
        description: "Reject a question request from the AI assistant.",
        operationId: "question.reject",
        responses: {
          200: {
            description: "Question rejected successfully",
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
      async (c) => {
        const params = c.req.valid("param")
        try {
          if (!(await Question.reject(params.requestID))) throw new Question.RequestNotFoundError()
        } catch (error) {
          questionError(error)
        }
        return c.json(true)
      },
    ),
)
