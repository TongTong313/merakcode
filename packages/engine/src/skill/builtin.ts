import { BUILTIN_SKILLS, type BuiltinSkill } from "./builtin/index"

/**
 * Lists built-in skills as virtual paths for addSkill in skill.ts; they come from code, not the file system
 */
export async function scanBuiltinSkills(): Promise<string[]> {
  return Object.keys(BUILTIN_SKILLS).map((name) => `<builtin>/${name}/SKILL.md`)
}

/**
 * Returns a built-in skill. The explicit `BuiltinSkill | undefined` return type forces callers to handle a missing
 * skill at compile time.
 */
export function getBuiltinSkill(name: string): BuiltinSkill | undefined {
  return BUILTIN_SKILLS[name]
}

/**
 * Virtual directory of built-in skills
 */
export function getBuiltinSkillsDir(): string {
  return "<builtin>"
}
