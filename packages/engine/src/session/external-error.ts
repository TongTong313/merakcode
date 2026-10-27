import { NamedError } from "@merakcode/util/error"
import { z } from "zod"

const Data = z.object({ message: z.string() })
export const ExternalBlockedError = NamedError.create("ExternalBlockedError", Data)
export const TakeoverConflictError = NamedError.create("TakeoverConflictError", Data)
export const ExternalOperationError = NamedError.create("ExternalOperationError", Data)
export const ExternalAdapterError = NamedError.create("ExternalAdapterError", Data)
