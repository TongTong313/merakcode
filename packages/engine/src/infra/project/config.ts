import z from "zod"

export namespace ProjectSettings {
  export const fields = {
    snapshot: z.boolean().optional(),
  }
}
