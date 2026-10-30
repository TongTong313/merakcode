// Pure logic of /assist/inline-edit (no Hono, Provider or model), kept separate for unit tests.
import type { Text } from "../../agent/prompt/text"

/** Strips a markdown code fence (``` or ```lang) from model output; text without a fence is returned as is */
export function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith("```")) return text
  const withoutOpen = trimmed.replace(/^```[^\n]*\n?/, "")
  const withoutClose = withoutOpen.replace(/\n?```\s*$/, "")
  return withoutClose
}

/** Inline edit request */
export type InlineEditInput = {
  instruction: string
  selectedText: string
  language?: string
  path?: string
}

/**
 * Builds the system prompt and prompt: output only the complete code replacing the selection, no explanations.
 * The prompt is in English. New comments follow the language of existing comments in the code, otherwise the UI
 * language (`ui`, from await Text.lang(); defaults to Chinese).
 */
export function buildInlineEditPrompt(
  input: InlineEditInput,
  ui: Text.Lang = "zh",
): { system: string; prompt: string } {
  const system = [
    "You are an inline code editing engine. Rewrite the given selection according to the user's instruction.",
    "Output only the complete code that replaces the selection: no explanations, no markdown code fences, no extra text around it.",
    "Keep the existing indentation style; if the instruction cannot be applied, output the selection unchanged.",
    `Match the language of the existing comments in the code; if there are none, write new comments in ${ui === "en" ? "English" : "Chinese"}.`,
  ].join("\n")
  const lang = input.language?.trim() || "text"
  const file = input.path?.trim() ? `\nFile: ${input.path.trim()}` : ""
  const prompt = [
    `Language: ${lang}${file}`,
    `Instruction: ${input.instruction.trim()}`,
    "<selection>",
    input.selectedText,
    "</selection>",
    "Output the complete code that replaces the selection:",
  ].join("\n")
  return { system, prompt }
}

/** Cleans model output: strips fences and surrounding blank lines; empty output falls back to the selection */
export function cleanInlineEditResult(raw: string, fallback: string): string {
  const text = stripFences(raw ?? "").replace(/\r\n/g, "\n")
  const trimmed = text.replace(/^\n+/, "").replace(/\n+$/, "")
  if (!trimmed.trim()) return fallback
  return trimmed
}

/** Validates the request body: both the instruction and the selection must be non-empty */
export function validateInlineEditBody(body: unknown): InlineEditInput | undefined {
  if (!body || typeof body !== "object") return
  const b = body as Record<string, unknown>
  if (typeof b.instruction !== "string" || !b.instruction.trim()) return
  if (typeof b.selectedText !== "string" || b.selectedText.length === 0) return
  return {
    instruction: b.instruction,
    selectedText: b.selectedText,
    language: typeof b.language === "string" ? b.language : undefined,
    path: typeof b.path === "string" ? b.path : undefined,
  }
}
