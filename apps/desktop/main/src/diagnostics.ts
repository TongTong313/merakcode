import type { connect } from "@merakcode/sdk"
import { writeFile } from "node:fs/promises"

const stamp = (now: Date) =>
  now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replaceAll(/[-:]/g, "")
    .replace("T", "-")

export async function exportDiagnostics(input: {
  client: Pick<Awaited<ReturnType<typeof connect>>, "diagnostics" | "blob"> | undefined
  choose: (name: string) => Promise<string | undefined>
  now?: Date
}) {
  if (!input.client) throw new Error("MRK-1004")
  const file = await input.choose(`merakcode-diagnostics-${stamp(input.now ?? new Date())}.zip`)
  if (!file) return false
  const { ref } = await input.client.diagnostics.bundle()
  const data = await input.client.blob.get(ref)
  try {
    await writeFile(file, data)
  } catch {
    throw new Error("MRK-1004")
  }
  return true
}
