import z from "zod"

/**
 * Session modes: plan permits research and the session plan, execute retains safety checks, and auto bypasses
 * authorization and sandbox enforcement without offering new human interactions.
 */
export namespace SessionMode {
  export const Schema = z.enum(["plan", "execute", "auto"]).meta({
    ref: "SessionMode",
  })
  export type Value = z.infer<typeof Schema>

  export const DEFAULT: Value = "execute"

  export function normalize(value?: Value): Value {
    return value ?? DEFAULT
  }

  /** Persisted legacy auto never authorizes the broader auto mode introduced by this schema. */
  export function migrate<T extends object>(value: T): T {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value
    const record = value as Record<string, unknown>
    if (!["readonly", "ask", "auto"].includes(String(record.permissionMode))) return value
    const { permissionMode, ...rest } = record
    return { ...rest, sessionMode: record.sessionMode ?? (permissionMode === "readonly" ? "plan" : "execute") } as T
  }

  const research = new Set([
    "invalid",
    "read",
    "glob",
    "grep",
    "ls",
    "lsp",
    "pdf_parse",
    "docx_parse",
    "excel_parse",
    "webfetch",
    "websearch",
    "codesearch",
    "skill",
    "rule",
    "todowrite",
    "subagent",
    "delegate",
    "question",
    "plan_exit",
    "plan_write",
    "plan_edit",
    "bash",
    "tool_search",
  ])
  export function allowsTool(mode: Value, tool: string) {
    if (mode === "auto" && /question|request_user_input|ask_user|^plan_(?:enter|exit)$/i.test(tool)) return false
    if (mode === "plan") return research.has(tool)
    return mode === "auto" || !["plan_exit", "plan_write", "plan_edit"].includes(tool)
  }
}
