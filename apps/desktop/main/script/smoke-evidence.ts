import { writeFile } from "node:fs/promises"

/** Keep the primary failure even when browser diagnostics cannot finish. */
export async function smokeEvidence(file: string, summary: string, inspect: () => Promise<string>, timeout = 5_000) {
  await writeFile(file, summary)
  let timer: NodeJS.Timeout | undefined
  try {
    const detail = await Promise.race([
      Promise.resolve().then(inspect),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser inspection timed out")), timeout)
      }),
    ]).catch((error: unknown) => `\n${String(error)}`)
    await writeFile(file, summary + detail)
  } finally {
    clearTimeout(timer)
  }
}
