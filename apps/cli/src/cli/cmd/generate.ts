// Prints the engine's OpenAPI document (used to generate the SDK)
import type { CommandModule } from "yargs"

export const GenerateCommand = {
  command: "generate",
  builder: (yargs) => yargs,
  handler: async () => {
    const { EngineHost } = await import("@merakcode/engine/host")
    const json = JSON.stringify(await EngineHost.openapi(), null, 2)
    // Let stdout drain before the entry point calls process.exit()
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(json, (error) => (error ? reject(error) : resolve())),
    )
  },
} satisfies CommandModule
