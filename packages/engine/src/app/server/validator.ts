import { validator as base } from "hono-openapi"
import z from "zod"
import { NamedError } from "@merakcode/util/error"

/** Invalid request input; answered as MRK-1009 with the offending fields in the message */
export const BadRequestError = NamedError.create(
  "BadRequestError",
  z.object({
    message: z.string(),
    issues: z.array(z.object({ path: z.array(z.string()), message: z.string() })),
  }),
)

type Issue = { message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }

const key = (segment: PropertyKey | { key: PropertyKey }) =>
  String(typeof segment === "object" && segment !== null ? segment.key : segment)

/** Throws BadRequestError for the route's input instead of answering a bare validation body */
export function reject(issues: readonly Issue[]): never {
  const list = issues.map((issue) => ({ path: (issue.path ?? []).map(key), message: issue.message }))
  throw new BadRequestError({
    message: list
      .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
      .join("; "),
    issues: list,
  })
}

type Args = Parameters<typeof base>

/** hono-openapi's validator; failures become BadRequestError unless the route passes its own hook */
export const validator = ((target: Args[0], schema: Args[1], hook?: Args[2], options?: Args[3]) =>
  base(
    target,
    schema,
    hook ??
      ((result) => {
        if (!result.success) reject(result.error)
      }),
    options,
  )) as typeof base
