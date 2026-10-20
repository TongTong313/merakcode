/**
 * Help → Export Diagnostics: the same zip as `merak bug-report`, with the app state instead of the doctor checks.
 */
import { join } from "node:path"
import { createBundle } from "@merakcode/log/bundle"

const stamp = (now: Date) =>
  now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replaceAll(/[-:]/g, "")
    .replace("T", "-")

export async function exportDiagnostics(input: {
  root: string
  dir: string
  info: Record<string, unknown>
  now?: Date
}) {
  const out = join(input.dir, `merakcode-report-${stamp(input.now ?? new Date())}.zip`)
  await createBundle({ root: input.root, out, extra: { "app.json": input.info } })
  return out
}
