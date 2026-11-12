const TITLE_LIMIT = 60

/** A note has no name of its own, so its first line stands for it. */
export function noteTitle(text: string) {
  const line =
    text
      .split("\n")
      .find((item) => item.trim())
      ?.trim() ?? ""
  return line.length > TITLE_LIMIT ? line.slice(0, TITLE_LIMIT - 1) + "…" : line
}

const kinds = {
  fact: "settings.memory.fact",
  decision: "settings.memory.decision",
  preference: "settings.memory.preference",
  pitfall: "settings.memory.pitfall",
} as const

/** The text that names the kind of a note. */
export const kindKey = (kind: string) => (kind in kinds ? kinds[kind as keyof typeof kinds] : undefined)
