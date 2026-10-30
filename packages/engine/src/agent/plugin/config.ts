import z from "zod"

export namespace PluginSettings {
  export const fields = {
    plugin: z.array(z.union([z.string(), z.tuple([z.string(), z.record(z.string(), z.unknown())])])).optional(),
    plugin_options: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  }
}
