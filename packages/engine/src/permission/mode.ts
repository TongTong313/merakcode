import z from "zod"

/**
 * Session permission modes:
 * - readonly: no edits, only allowlisted read-only commands; reads outside the workspace, sensitive files and network
 *   access are still asked about
 * - ask (default): edits inside the workspace go through directly (hunks can be reverted later in review); other risky
 *   operations are asked about
 * - auto: asks only for sensitive files, writes outside the workspace, risky commands, leaving the sandbox and network
 *   access
 */
export namespace PermissionMode {
  export const Schema = z.enum(["readonly", "ask", "auto"]).meta({
    ref: "PermissionMode",
  })
  export type Value = z.infer<typeof Schema>

  export const DEFAULT: Value = "ask"

  export function normalize(value?: Value): Value {
    return value ?? DEFAULT
  }
}
