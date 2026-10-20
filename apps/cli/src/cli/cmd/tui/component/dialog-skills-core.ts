export type SkillDialogTab = "installed" | "remote"
export type SkillInstallTarget = "project" | "global"

export function skillIsProject(skill: { location: string; scope?: "global" | "project" | "builtin" }): boolean {
  if (skill.scope) return skill.scope === "project"
  return !skill.location.includes(".config") && !skill.location.startsWith("~")
}

export function installTargetAvailable(target: SkillInstallTarget, disabled: SkillInstallTarget[]): boolean {
  return !disabled.includes(target)
}

export function availableInstallTarget(disabled: SkillInstallTarget[]): SkillInstallTarget {
  if (installTargetAvailable("project", disabled)) return "project"
  return "global"
}

export const skillDialogTabs: SkillDialogTab[] = ["installed", "remote"]

export const skillDialogDefaultTab: SkillDialogTab = "installed"

export function skillUninstallTransition(current: string | undefined, action: "press" | "reset", id: string) {
  if (action === "reset") return {}
  if (current === id) return { remove: id }
  return { confirm: id }
}

export function clampSkillIndex(current: number, count: number) {
  return Math.max(0, Math.min(current, count - 1))
}

/**
 * Maximum display length (in characters) of a description line in the skills dialog.
 *
 * Keeps the description on one line at any terminal width without relying on overflow="hidden".
 *
 * After a terminal resize, OpenTUI 0.3.4 may fail to overwrite old glyphs with transparent spaces, which shows up as
 * swallowed spaces and stray characters (e.g. "Creatingmalgorithmicoart..."). Callers must also give the description
 * an opaque background and update it as a whole through the `content` prop; this keeps the text shorter than the
 * available cells so the extra clipping and wrapping paths are never hit.
 */
export function skillDescMaxWidth(termWidth: number, cap: number): number {
  const available = Math.min(80, termWidth - 2) - 8
  return Math.max(8, Math.min(cap, available))
}

/**
 * Truncates a skill description to the available width: collapses whitespace to single spaces and cuts overlong text
 * with a three-character "..." ellipsis.
 */
export function truncateSkillDesc(desc: string, maxWidth: number): string {
  const clean = desc.replace(/\s+/g, " ").trim()
  if (clean.length <= maxWidth) return clean
  if (maxWidth <= 3) return "...".slice(0, maxWidth)
  return clean.slice(0, maxWidth - 3) + "..."
}
