/**
 * Strips ANSI escape sequences.
 *
 * This is the only irreversible transform: color codes cannot be restored. They carry style only, no meaning (the
 * model does not need to know FAILED was red), so the later transforms check their round trip against the text with
 * ANSI already stripped, not the raw input.
 */

// CSI SGR (colors and styles): ESC [ ... m
const SGR_RE = /\x1b\[[0-9;]*m/g
// Other CSI sequences such as cursor movement and clearing: ESC [ ... <final byte>
const CSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g
// OSC sequences (e.g. setting the terminal title): ESC ] ... BEL or ESC \
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

export function stripAnsi(text: string) {
  if (!text.includes("\x1b")) return text
  return text.replace(OSC_RE, "").replace(SGR_RE, "").replace(CSI_RE, "")
}
