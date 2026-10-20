/**
 * Line splitting and joining.
 *
 * Splits on "\n" only and keeps "\r" as part of the line, so CRLF output is rebuilt byte for byte. Every inverse
 * transform relies on this to pass its round-trip check.
 */

export type Split = {
  lines: string[]
  /** Whether the text ended with a newline, so joining neither adds nor drops one */
  trailing: boolean
}

export function split(text: string): Split {
  if (text === "") return { lines: [], trailing: false }
  const trailing = text.endsWith("\n")
  const body = trailing ? text.slice(0, -1) : text
  return { lines: body.split("\n"), trailing }
}

export function join(lines: string[], trailing: boolean) {
  const out = lines.join("\n")
  return trailing ? `${out}\n` : out
}

export function bytes(text: string) {
  return Buffer.byteLength(text, "utf8")
}
