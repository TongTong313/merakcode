import z from "zod"

export namespace WatcherSettings {
  export const fields = {
    watcher: z
      .object({
        ignore: z.array(z.string()).optional(),
      })
      .optional(),
  }
}
