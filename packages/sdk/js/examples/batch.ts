// Batch processing: independent draft-only tasks use the SDK and approve only their requested file reads.
// Run: node batch.ts a.md b.md c.md
import path from "node:path"
import { createMerakCode } from "@merakcode/sdk"

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error("Usage: node batch.ts <file>...")
  process.exit(1)
}

const merak = await createMerakCode({ cwd: process.cwd() })
try {
  const summaries = await Promise.all(
    files.map(async (file) => {
      const session = await merak.session({ title: path.basename(file) })
      let text = ""
      const run = session.run(
        `Read ${file} and sum it up in one sentence. Do not modify files. Reply with that sentence only.`,
        {
          model: process.env.MERAKCODE_MODEL,
          permissionLevel: "ask",
          onPermission: (request) =>
            request.permission === "read" &&
            request.patterns.every((pattern) => path.resolve(pattern) === path.resolve(file))
              ? "allow-once"
              : "deny",
        },
      )
      for await (const event of run) {
        if (event.type === "text") text += event.delta
        if (event.type === "error") text = `[${event.error.code}] ${event.error.message}`
      }
      return { file, text: text.trim() }
    }),
  )
  for (const { file, text } of summaries) console.log(`${file}: ${text}`)
} finally {
  await merak.close()
}
