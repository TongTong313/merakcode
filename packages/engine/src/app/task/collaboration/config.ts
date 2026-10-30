import z from "zod"

export namespace CollaborationConfig {
  export const RoleTemplate = z.object({
    name: z.string().trim().min(1),
    role: z.string().trim().min(1),
    duty: z.string().trim().min(1),
  })
}
