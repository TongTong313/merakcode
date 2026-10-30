import path from "node:path"

export function getPluginName(plugin: string): string {
  if (plugin.startsWith("file://")) {
    return path.parse(new URL(plugin).pathname).name
  }
  const lastAt = plugin.lastIndexOf("@")
  if (lastAt > 0) {
    return plugin.substring(0, lastAt)
  }
  return plugin
}

/**
 * Deduplicates plugins by name, with later entries (higher priority) winning.
 * Priority order (highest to lowest):
 * 1. Local plugin/ directory
 * 2. Local merakcode.json
 * 3. Global plugin/ directory
 * 4. Global merakcode.json
 *
 * Since plugins are added in low-to-high priority order,
 * we reverse, deduplicate (keeping first occurrence), then restore order.
 */
/** A plugin entry: a package specifier string, or opencode's `[name, options]` tuple */
export type PluginEntry = string | [string, Record<string, unknown>]

/** The specifier of an entry (the first item of a tuple) */
export function pluginSpecifier(entry: PluginEntry): string {
  return typeof entry === "string" ? entry : entry[0]
}

export function deduplicatePlugins(plugins: PluginEntry[]): PluginEntry[] {
  // seenNames: canonical plugin names for duplicate detection
  // e.g., "oh-my-merakcode", "@scope/pkg"
  const seenNames = new Set<string>()

  // uniqueSpecifiers: full plugin specifiers to return
  // e.g., "oh-my-merakcode@2.4.3", "file:///path/to/plugin.js"
  const uniqueSpecifiers: PluginEntry[] = []

  for (const entry of plugins.toReversed()) {
    const name = getPluginName(pluginSpecifier(entry))
    if (!seenNames.has(name)) {
      seenNames.add(name)
      uniqueSpecifiers.push(entry)
    }
  }

  return uniqueSpecifiers.toReversed()
}
