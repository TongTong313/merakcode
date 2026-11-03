import z from "zod"
import { NamedError } from "@merakcode/util/error"

/** Root conversation authorization, independent of the current task's scope. */
export namespace PermissionLevel {
  export const Schema = z.enum(["ask", "autoApprove", "fullTakeover"]).meta({ ref: "PermissionLevel" })
  export type Value = z.infer<typeof Schema>
  export const DEFAULT: Value = "ask"
  export const ConflictError = NamedError.create("PermissionRevisionConflictError", z.object({ message: z.string() }))

  /** Persisted legacy values never authorize the new permission levels. */
  export function migrate<T extends object>(value: T, source: "session" | "message" = "session"): T {
    const record = value as Record<string, unknown>
    if (!record || typeof record !== "object" || Array.isArray(record)) return value
    if (
      Schema.safeParse(record.permissionLevel).success &&
      (source === "message" || z.number().int().nonnegative().safeParse(record.permissionRevision).success) &&
      !("sessionMode" in record || "permissionMode" in record)
    )
      return value
    const { sessionMode, permissionMode, modeRevision, ...rest } = record
    return {
      ...rest,
      permissionLevel: DEFAULT,
      permissionRevision: 0,
      permissionNotice: "legacy-permissions-reset",
      permissionGrants: undefined,
      permission: Array.isArray(record.permission)
        ? record.permission.filter((rule) => rule.action === "deny")
        : undefined,
    } as T
  }

  export function allowsTool(_level: Value, tool: string) {
    return !["plan_enter", "plan_exit", "plan_write"].includes(tool)
  }
}
