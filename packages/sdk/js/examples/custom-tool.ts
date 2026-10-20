// Custom tool: the tool is defined in this process; when the model calls it, the engine forwards the call here and
// passes the result back to the model.
// Run: node custom-tool.ts
import { createMerakCode, tool } from "@merakcode/sdk"
import { z } from "zod"

const inventory: Record<string, number> = { apple: 12, pear: 0 }

const stock = tool({
  name: "stock",
  description: "Look up how many of a fruit are in stock",
  args: { fruit: z.string().describe("Fruit name in English, such as apple") },
  run: ({ fruit }) => {
    console.log(`[stock] looking up ${fruit}`)
    return String(inventory[fruit] ?? 0)
  },
})

const merak = await createMerakCode({ cwd: process.cwd(), tools: [stock] })
try {
  const session = await merak.session()
  const run = session.run("How many apples are in stock? Check with the stock tool and answer with the number.", {
    model: process.env.MERAKCODE_MODEL,
    // Custom tool calls need approval too; only stock is allowed here
    onPermission: (request) => (request.permission === "stock" ? "allow-once" : "deny"),
  })
  for await (const event of run) {
    if (event.type === "text") process.stdout.write(event.delta)
    if (event.type === "error") console.error(`\n[${event.error.code}] ${event.error.message}`)
  }
  process.stdout.write("\n")
} finally {
  await merak.close()
}
