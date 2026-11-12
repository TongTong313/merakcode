/** The name of a rule file as the engine wants it: no extension, letters, digits, dot, dash and underscore, with / for folders. */
export function ruleName(input: string): string | undefined {
  const name = input.trim().replace(/\.mdc$/i, "")
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name)) return
  return name.split("/").some((part) => part === "." || part === "..") ? undefined : name
}

/** What a new rule file holds until the person writes the rule. */
export const newRuleBody = () => "---\ndescription: \nalwaysApply: false\n---\n\n"

const kinds = {
  always: "settings.rules.always",
  matching: "settings.rules.auto",
  described: "settings.rules.requested",
} as const

/** The text that says how a rule reaches the model. */
export const kindKey = (kind: string) => (kind in kinds ? kinds[kind as keyof typeof kinds] : undefined)
