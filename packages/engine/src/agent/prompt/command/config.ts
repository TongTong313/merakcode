import z from "zod"
import { ModelId } from "../../model/config"

export namespace CommandConfig {
  export const Command = z.object({
    template: z.string(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: ModelId.optional(),
    subtask: z.boolean().optional(),
  })
  export type Command = z.infer<typeof Command>
}

export namespace CommandSettings {
  const Command = CommandConfig.Command
  export const fields = {
    command: z.record(z.string(), Command).optional().describe("Command configuration"),
  }
}
