// Minimal agent: starts an engine, opens a session, sends one message and prints the reply as it streams.
// Run: node minimal.ts (uses the default model of a connected provider; set MERAKCODE_MODEL=provider/model to choose)
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
try {
  const session = await merak.session()
  for await (const event of session.run("Introduce yourself in one sentence.", {
    model: process.env.MERAKCODE_MODEL,
  })) {
    if (event.type === "text") process.stdout.write(event.delta)
    if (event.type === "error") console.error(`\n[${event.error.code}] ${event.error.message}`)
  }
  process.stdout.write("\n")
} finally {
  await merak.close()
}
