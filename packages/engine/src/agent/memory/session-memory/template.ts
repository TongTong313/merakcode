/**
 * SessionMemory notes template. The notes are only read by models (maintained by the extraction agent, injected by
 * compaction), so they are in English.
 *
 * Each section has two parts that extraction must keep intact:
 * 1. The heading line (starts with #)
 * 2. The italic description line (_..._) right after the heading; it is a template instruction and must not change
 * The extraction agent may only update the content below the description line.
 *
 * The parsers below (isEmptyTemplate / truncateSections) only look at leading `#` and `_`, not at heading text, so
 * existing notes files with older non-English headings still work (existing files are never rewritten).
 */

/** Default notes template with 10 fixed sections */
export const SESSION_MEMORY_TEMPLATE = [
  "# Session Title",
  "_A short, distinctive 5-10 word descriptive title. Info-dense, no filler_",
  "",
  "# Current State",
  "_What is being worked on right now? Pending tasks not yet done. What are the immediate next steps?_",
  "",
  "# Task Specification",
  "_What did the user ask to build? Design decisions or other explanatory context_",
  "",
  "# Files and Functions",
  "_Which files matter? Briefly, what they contain and why they are relevant_",
  "",
  "# Workflow",
  "_Which bash commands are usually run, and in what order? How to read their output?_",
  "",
  "# Errors and Corrections",
  "_Errors hit and how they were fixed. What did the user correct? Which approaches failed and should not be retried?_",
  "",
  "# Codebase and System Documentation",
  "_What are the important system components? How do they work and fit together?_",
  "",
  "# Learnings",
  "_What worked? What did not? What to avoid? Do not repeat other sections_",
  "",
  "# Key Results",
  "_If the user asked for a specific output (an answer, a table, etc.), record it here exactly_",
  "",
  "# Worklog",
  "_Step by step: what was tried and what was done? A very terse summary per step_",
  "",
].join("\n")

/**
 * Whether the notes are still the empty template (only heading and description lines).
 * An empty template must not be injected as the compaction summary; compaction falls back to an LLM summary.
 */
export function isEmptyTemplate(content: string): boolean {
  if (!content.trim()) return true
  const stripped = content
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#") && !line.startsWith("_"))
    .join("")
    .trim()
  return stripped.length === 0
}

/**
 * Truncates each section to at most maxTokens, keeping the heading and description lines and appending a marker.
 * Compaction calls this before injection so the notes do not use up the summary budget.
 */
export function truncateSections(content: string, maxTokens: number): string {
  const charBudget = maxTokens * 4
  const sections = content.split(/\n(?=#)/)
  return sections
    .map((section) => {
      if (section.length <= charBudget) return section
      const lines = section.split("\n")
      const header = lines.slice(0, 2).join("\n") // heading + italic description
      const body = lines.slice(2).join("\n").slice(0, charBudget)
      return `${header}\n${body}\n[... section truncated for length ...]`
    })
    .join("\n")
}
