import { MemoryPath } from "../path"
import { MemoryPrompt } from "../prompt"

/**
 * Builds the four-phase memory consolidation prompt for the four-type layout
 * (user/feedback/project/reference plus the MEMORY.md index). The LLM does all of the consolidation: it merges
 * new signal into existing topic files, converts dates to absolute ones, deletes disproven facts and prunes the index.
 *
 * @param memoryDir absolute path of the memory directory
 * @param extra additional context (tool constraints plus the sessions since the last consolidation)
 * @param today today's date (YYYY-MM-DD), used to have relative dates converted to absolute ones
 */
export function buildConsolidationPrompt(memoryDir: string, extra: string, today: string): string {
  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize the fragmented memories gathered recently into durable, well-organized memories so that future sessions can find things quickly.

Today is ${today}. Convert relative dates in memories ("yesterday", "last week") into absolute dates so they stay interpretable over time.

Memory directory: \`${memoryDir}\` (the directory already exists; update files directly with the Edit/Write tools, no need to mkdir or check that it exists)

---

## Phase 1 - Orient

- Use \`ls\` / \`glob\` to view the memory directory and its \`user/\`, \`feedback/\`, \`project/\`, \`reference/\` subdirectories
- Read \`${MemoryPath.ENTRYPOINT_NAME}\` to understand the current index
- Skim the existing topic files so you improve them rather than create near-duplicates

## Phase 2 - Gather recent signal

Look for new information worth persisting, in priority order:

1. **Existing memories that have drifted** — facts that contradict the current codebase or have been overturned by later work
2. **Memory file search** — if you need specific context, run a narrow \`grep\` over the memory files; do not read everything

Do not read everything exhaustively. Only look for things you already suspect matter.

## Phase 3 - Consolidate

For each piece of information worth keeping, update or create a memory file (follow the frontmatter format and the four-type convention: \`user/\`, \`feedback/\`, \`project/\`, \`reference/\`):

- **Merge new signal into existing topic files** instead of creating near-duplicates
- Convert relative dates into absolute dates
- **Delete disproven facts** — if today's investigation overturns an old memory, fix it at the source

## Phase 4 - Prune and index

Update \`${MemoryPath.ENTRYPOINT_NAME}\`, keeping it under ${MemoryPrompt.MAX_ENTRYPOINT_LINES} lines and under ~25KB. It is an **index**, not content — one line per entry, at most ~150 characters: \`- [Title](file.md) - one-line hook\`. Never write memory content into the index.

- Remove pointers to stale, wrong, or superseded memories
- Demote verbose entries: an index line over ~200 characters is carrying content that belongs in the topic file — shorten the line and move the details there
- Add pointers to important new memories
- Resolve contradictions — when two files conflict, fix the wrong one

---

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (the memories are already tight), just say so.${extra ? `\n\n## Additional Context\n\n${extra}` : ""}`
}
