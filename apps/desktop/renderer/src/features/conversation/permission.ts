// Approval bar options and display for the desktop app. Only provides choices, translation keys and variables; the UI
// translates and renders them itself.

type PermissionScope = "file" | "directory" | "prefix" | "agent" | "tool" | "domain"

export type PermissionRequestLike = {
  permission: string
  patterns: string[]
  grants?: { scope: PermissionScope; pattern: string }[]
  always?: boolean
  metadata?: Record<string, unknown>
}

export type PermissionChoice = {
  /** Stable choice id, used for UI key bindings and tests */
  id: string
  reply: "once" | "session" | "always" | "reject"
  scope?: PermissionScope
  label: { key: string; vars?: Record<string, string> }
}

/** How a grant pattern is shown in the UI: "npm install *" → "npm install", "/a/docs/*" → "/a/docs" */
function display(pattern: string) {
  return pattern.replace(/ \*$/, "").replace(/\/\*$/, "")
}

/** Approval bar choices: allow once → each session grant → always allow (when available) → reject */
export function permissionChoices(request: PermissionRequestLike): PermissionChoice[] {
  const grants = request.grants ?? []
  return [
    { id: "once", reply: "once", label: { key: "permission.option.once" } },
    ...grants.map((grant) => ({
      id: `session:${grant.scope}`,
      reply: "session" as const,
      scope: grant.scope,
      label: { key: `permission.option.${grant.scope}`, vars: { pattern: display(grant.pattern) } },
    })),
    ...(request.always ? [{ id: "always", reply: "always" as const, label: { key: "permission.option.always" } }] : []),
    { id: "reject", reply: "reject", label: { key: "permission.option.reject" } },
  ]
}

export type PermissionKind = "command" | "edit" | "read" | "network" | "subagent" | "workflow" | "mcp" | "tool"

const KINDS: Record<string, PermissionKind> = {
  bash: "command",
  edit: "edit",
  read: "read",
  network: "network",
  subagent: "subagent",
  workflow_run: "workflow",
  mcp: "mcp",
}

/**
 * Approval category, which decides how the title and body are shown. Tool approvals use the permission itself
 * (e.g. grep, lsp, plugin tool names).
 */
export function permissionKind(permission: string): PermissionKind {
  return KINDS[permission] ?? "tool"
}

/** Known risk tags, in display order */
const TAGS = ["forbidden", "sensitive-path", "external-path", "sudo", "delete", "publish", "network", "no-sandbox"]

/** Risks to highlight on an approval, produced by command analysis (see CommandAnalysis in the engine) */
export function permissionTags(request: { metadata?: Record<string, unknown> }): string[] {
  const tags = request.metadata?.tags
  if (!Array.isArray(tags)) return []
  return TAGS.filter((tag) => tags.includes(tag))
}
