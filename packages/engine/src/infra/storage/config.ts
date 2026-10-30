import z from "zod"

export namespace StorageSettings {
  export const fields = {
    storage: z
      .object({
        retention_days: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Delete sessions inactive for more than N days; by default no history is deleted"),
      })
      .optional(),
  }
}
