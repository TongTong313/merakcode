import { resolver } from "hono-openapi"
import z from "zod"

/** Body of every error the server answers with itself (see Server.compose) */
export const ErrorResponse = z
  .object({
    name: z.string(),
    code: z.string().describe("Stable error code, e.g. MRK-1011 (see docs/errors.md)"),
    message: z.string().optional(),
    data: z.any(),
    requestID: z.string().optional().describe("Same as the x-request-id response header; quote it in bug reports"),
  })
  .meta({ ref: "ErrorResponse" })

export const ERRORS = {
  400: {
    description: "Bad request",
    content: {
      "application/json": {
        schema: resolver(ErrorResponse),
      },
    },
  },
  404: {
    description: "Not found",
    content: {
      "application/json": {
        schema: resolver(ErrorResponse),
      },
    },
  },
  409: {
    description: "Checkout is busy or the request conflicts with its current state",
    content: {
      "application/json": {
        schema: resolver(ErrorResponse),
      },
    },
  },
} as const

export function errors(...codes: number[]) {
  return Object.fromEntries(codes.map((code) => [code, ERRORS[code as keyof typeof ERRORS]]))
}
