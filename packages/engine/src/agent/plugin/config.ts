import z from "zod"

export namespace PluginSettings {
  export function merge(
    target: { plugin?: z.infer<typeof fields.plugin> },
    source: { plugin?: z.infer<typeof fields.plugin> },
  ) {
    if (!target.plugin || !source.plugin) return {}
    return { plugin: Array.from(new Set([...target.plugin, ...source.plugin])) }
  }
  export const fields = {
    plugin: z.array(z.union([z.string(), z.tuple([z.string(), z.record(z.string(), z.unknown())])])).optional(),
    plugin_options: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  }
}
