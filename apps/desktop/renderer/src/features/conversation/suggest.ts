/**
 * Composer suggestions: files when "@word" precedes the caret, commands when "/word" is at the start or after a
 * space. Pure functions; the component only renders.
 */

export type Trigger = { kind: "file" | "command"; query: string; start: number; end: number }

/** Suggestion trigger at the caret: @ and / must follow the start or whitespace, and / must be the token being typed */
export function trigger(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret)
  const command = /(?:^|\s)\/(\S*)$/.exec(before)
  if (command && !text.slice(caret).trim()) {
    const slash = before.lastIndexOf("/")
    return { kind: "command", query: command[1]!, start: slash, end: caret }
  }
  const file = /(^|\s)@([^\s@]*)$/.exec(before)
  if (file) return { kind: "file", query: file[2]!, start: caret - file[2]!.length - 1, end: caret }
}

/** Replaces the trigger with the chosen value plus a space; returns the new text and caret position */
export function apply(text: string, at: Trigger, value: string) {
  const insert = `${at.kind === "file" ? "@" : "/"}${value} `
  const rest = text.slice(at.end).replace(/^ /, "")
  return { text: text.slice(0, at.start) + insert + rest, caret: at.start + insert.length }
}

/**
 * Local path → file:// URL. Works for Windows drive paths too; each segment is encoded, so #, ?, spaces and non-ASCII
 * characters survive.
 */
export function fileUrl(path: string) {
  const slashed = path.replace(/\\/g, "/")
  const absolute = slashed.startsWith("/") ? slashed : `/${slashed}`
  return `file://${absolute
    .split("/")
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/")}`
}
