import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import z from "zod"
import { lazy } from "@merakcode/util/lazy"
import { commitMessage, inlineEdit } from "../../assist"

export const AssistRoutes = lazy(() => {
  const app = new Hono()

  /**
   * Generates a git commit message (the commit action of the desktop review panel).
   * A fixed, non-agentic flow: run git for the staged diff (or the working tree when nothing is staged) and the last
   * 5 commit messages, then make one call to the small model, which follows the one-shot examples.
   * Never returns 500: no changes give an empty message; a failed model call gives an empty message plus `error`,
   * which the UI shows.
   */
  app.post(
    "/commit-message",
    describeRoute({
      summary: "Generate git commit message",
      operationId: "assist.commit.message",
      responses: {
        200: {
          description: "Generated commit message",
          content: {
            "application/json": {
              schema: resolver(z.object({ message: z.string(), error: z.string().optional() })),
            },
          },
        },
      },
    }),
    async (c) => {
      // The desktop app sends the project directory as x-merakcode-directory (each repository separately); the
      // server middleware builds the Instance from it, so the worktree is that repository's root.
      return c.json(await commitMessage())
    },
  )

  /**
   * Ctrl+K inline edit: rewrites the selection per the instruction in a single, non-agentic call.
   * Optional body.providerID/modelID apply to this request only; the default is Provider.defaultModel.
   * Never returns 500: on failure `text` is empty and `error` is set.
   */
  app.post(
    "/inline-edit",
    describeRoute({
      summary: "Inline edit selected code",
      operationId: "assist.inline.edit",
      responses: {
        200: {
          description: "Replacement text for the selection",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  text: z.string(),
                  providerID: z.string().optional(),
                  modelID: z.string().optional(),
                  error: z.string().optional(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator(
      "json",
      z.object({
        instruction: z.string(),
        selectedText: z.string(),
        language: z.string().optional(),
        path: z.string().optional(),
        providerID: z.string().optional(),
        modelID: z.string().optional(),
      }),
    ),
    async (c) => {
      return c.json(await inlineEdit(c.req.valid("json")))
    },
  )

  return app
})
