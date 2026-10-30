/**
 * Truncation of tool input content (projection layer).
 *
 * Independent of read-lifecycle (replaces stale read output) and context-budget output pruning (clears tool output):
 *   - read-lifecycle handles whether read content is still valid (correctness)
 *   - output pruning handles the size of tool results (cleared and replaced with a placeholder)
 *   - this layer handles the size of write/edit inputs (content fields truncated)
 * They act on different fields and can be combined.
 *
 * Why truncation is safe: input.content of write/edit is text the model just generated and wrote to disk. The model
 * does not need the input to remember it; it knows filePath and can Read the file again. Truncating old write/edit
 * content over budget therefore loses nothing and usually frees more tokens than output pruning (write inputs can
 * take 30%+ of a real session's context, tool outputs often only a few percent).
 *
 * Unlike output pruning, the whole input is not cleared: filePath/path is how the model locates the file and must be
 * kept, so only the content fields are truncated and marked.
 */
import { Token } from "../context/token"
import { Message } from "./message"

export namespace SessionToolInput {
  /** Appended to truncated content fields; tells the model to Read the file for the full text */
  export const TRUNCATION_MARKER =
    "\n\n[... content truncated due to context budget; use Read to re-read the file for full text]"

  /** Truncatable content fields. Structural fields (filePath/path/type/mode) are always kept. */
  const CONTENT_FIELDS: Record<string, string[]> = {
    write: ["content"],
    edit: ["oldString", "newString"],
    multi_edit: ["edits"],
    apply_patch: ["patchText"],
  }

  /** Whether the tool has truncatable content fields */
  export function isTruncatable(tool: string) {
    return tool in CONTENT_FIELDS
  }

  /** Estimates the tokens in a tool input's content fields, for the input budget */
  export function estimateTokens(part: Message.ToolPart): number {
    const fields = CONTENT_FIELDS[part.tool]
    if (!fields) return 0
    const input = part.state.input
    if (!input || typeof input !== "object") return 0
    let total = 0
    for (const field of fields) {
      total += estimateField((input as Record<string, unknown>)[field])
    }
    return total
  }

  /**
   * Truncates content fields: long strings are sliced and marked; arrays (multi_edit.edits) are truncated per item.
   * Structural fields are untouched. Returns whether anything was truncated.
   */
  export function truncate(part: Message.ToolPart, maxChars: number): boolean {
    const fields = CONTENT_FIELDS[part.tool]
    if (!fields) return false
    const input = part.state.input
    if (!input || typeof input !== "object") return false
    const record = input as Record<string, unknown>
    let changed = false
    for (const field of fields) {
      const value = record[field]
      if (typeof value === "string" && value.length > maxChars) {
        record[field] = value.slice(0, maxChars) + TRUNCATION_MARKER
        changed = true
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object") {
            const edit = item as Record<string, unknown>
            for (const sub of ["oldString", "newString"]) {
              const v = edit[sub]
              if (typeof v === "string" && v.length > maxChars) {
                edit[sub] = v.slice(0, maxChars) + TRUNCATION_MARKER
                changed = true
              }
            }
          }
        }
      }
    }
    return changed
  }

  function estimateField(value: unknown): number {
    if (typeof value === "string") return Token.estimate(value)
    if (Array.isArray(value)) {
      return value.reduce((sum, item) => {
        if (item && typeof item === "object") {
          const edit = item as Record<string, unknown>
          return (
            sum +
            (typeof edit.oldString === "string" ? Token.estimate(edit.oldString) : 0) +
            (typeof edit.newString === "string" ? Token.estimate(edit.newString) : 0)
          )
        }
        return sum
      }, 0)
    }
    return 0
  }
}
