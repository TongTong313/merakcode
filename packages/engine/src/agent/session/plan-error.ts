import z from "zod"
import { NamedError } from "@merakcode/util/error"

export const PlanConflictError = NamedError.create("PlanConflictError", z.object({ message: z.string() }))
export const PlanReadRangeError = NamedError.create("PlanReadRangeError", z.object({ message: z.string() }))
export const PlanExecutionPausedError = NamedError.create("PlanExecutionPausedError", z.object({ message: z.string() }))
