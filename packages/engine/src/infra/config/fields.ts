import z from "zod"

export namespace CommonSettings {
  export const fields = {
    $schema: z.string().optional().describe("JSON schema reference for configuration validation"),
  }
}
