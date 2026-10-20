import { createMemo, createResource } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { useLocale } from "../context/locale"
import { useToast } from "../ui/toast"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"

type Scope = "project" | "global"
type Action = "allow" | "ask" | "deny"

type Item =
  | { kind: "mode"; mode: "readonly" | "ask" | "auto" }
  | { kind: "sandbox"; action: "toggle" | "install" | "reset" }
  | { kind: "grant"; permission: string; pattern: string }
  | { kind: "rule"; scope: Scope; permission: string; pattern: string }
  | { kind: "add" }

/** Permission keys that accept rules (same categories as the engine's PermissionPolicy), most common first. */
const RULE_KEYS = [
  "bash",
  "bash_delete",
  "bash_risky",
  "bash_forbidden",
  "network",
  "edit",
  "protected_write",
  "external_write",
  "read",
  "external_read",
  "sensitive_read",
  "sandbox",
  "subagent",
  "mcp",
]

/** Placeholder for the new-rule input, depending on the permission key. */
function placeholder(key: string) {
  if (key.startsWith("bash")) return "command"
  if (key === "network") return "domain"
  if (key === "mcp") return "mcp"
  if (key === "subagent") return "agent"
  if (key === "sandbox") return "dir"
  return "path"
}

/**
 * /permissions: permission mode, sandbox, grants for this session (selecting one revokes it), and rules from project
 * and global config (selecting one deletes it; new ones can be added). `sessionID` is the current session; a child
 * session works too, since grants are recorded on the root session.
 */
export function DialogPermissions(props: { sessionID?: string }) {
  const sdk = useSDK()
  const local = useLocal()
  const locale = useLocale()
  const toast = useToast()
  const dialog = useDialog()
  const { theme } = useTheme()

  const [sandbox, { refetch: refetchSandbox }] = createResource(() =>
    sdk.client.sandbox.status().then((res) => res.data),
  )
  const [grants, { refetch: refetchGrants }] = createResource(
    () => props.sessionID,
    (sessionID) => sdk.client.permission.grants({ sessionID }).then((res) => res.data ?? []),
  )
  const [rules, { refetch: refetchRules }] = createResource(() =>
    sdk.client.permission.rules().then((res) => res.data ?? { project: [], global: [] }),
  )

  const options = createMemo((): DialogSelectOption<Item>[] => {
    const mode = local.permissionMode.current()
    const modes = (["readonly", "ask", "auto"] as const).map((value) => ({
      title: locale.t(`status.mode.${value}`) + (value === mode ? "  ✓" : ""),
      description: locale.t(`permissions.mode.${value}`),
      value: { kind: "mode" as const, mode: value },
      category: locale.t("permissions.category.mode"),
    }))

    const info = sandbox()
    const limits = (info?.degraded ?? []).map((item) => locale.t(`cli.sandbox.limit.${item}`)).join(" ")
    const sandboxRows: DialogSelectOption<Item>[] = info
      ? [
          {
            title: locale.t(`status.sandbox.${info.status}`),
            description: info.installable
              ? locale.t("permissions.sandbox.installable")
              : info.status === "on" && limits
                ? limits
                : (info.reason ?? locale.t(`permissions.sandbox.${info.status}`)),
            value: { kind: "sandbox", action: info.installable ? "install" : "toggle" },
            footer: (
              <span style={{ fg: theme.textMuted }}>
                {locale.t(info.installable ? "permissions.sandbox.install" : "permissions.sandbox.toggle")}
              </span>
            ),
            category: locale.t("permissions.category.sandbox"),
          },
          ...(info.backend === "windows-account"
            ? [
                {
                  title: locale.t("permissions.sandbox.reset"),
                  description: locale.t("permissions.sandbox.resetHint"),
                  value: { kind: "sandbox" as const, action: "reset" as const },
                  category: locale.t("permissions.category.sandbox"),
                },
              ]
            : []),
        ]
      : []

    const grantRows = (grants() ?? []).map((rule) => ({
      title: rule.pattern,
      description: locale.t(`permissions.key.${rule.permission}`),
      value: { kind: "grant" as const, permission: rule.permission, pattern: rule.pattern },
      footer: <span style={{ fg: theme.textMuted }}>{locale.t("permissions.grant.revoke")}</span>,
      category: locale.t("permissions.category.grants"),
    }))

    const ruleRows = (["project", "global"] as const).flatMap((scope) =>
      (rules()?.[scope] ?? []).map((rule) => ({
        title: `${rule.pattern} → ${locale.t(`permissions.action.${rule.action}`)}`,
        description: `${locale.t(`permissions.key.${rule.permission}`)} · ${locale.t(`permissions.scope.${scope}`)}`,
        value: { kind: "rule" as const, scope, permission: rule.permission, pattern: rule.pattern },
        footer: <span style={{ fg: theme.textMuted }}>{locale.t("permissions.rule.remove")}</span>,
        category: locale.t("permissions.category.rules"),
      })),
    )
    const addRow: DialogSelectOption<Item> = {
      title: locale.t("permissions.rule.add"),
      description: locale.t("permissions.rule.addHint"),
      value: { kind: "add" },
      category: locale.t("permissions.category.rules"),
    }
    return [...modes, ...sandboxRows, ...grantRows, ...ruleRows, addRow]
  })

  const reopen = () => dialog.replace(() => <DialogPermissions sessionID={props.sessionID} />)
  const fail = (error: unknown) =>
    toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error", duration: 4000 })

  /** Adds a rule: pick a category, enter a pattern, pick an action; written to this project's config. */
  const add = () =>
    dialog.replace(() => (
      <DialogSelect
        title={locale.t("permissions.rule.pickKey")}
        options={RULE_KEYS.map((key) => ({ title: locale.t(`permissions.key.${key}`), value: key }))}
        onSelect={async (option) => {
          const permission = option.value
          const pattern = (
            await DialogPrompt.show(dialog, locale.t(`permissions.key.${permission}`), {
              placeholder: locale.t(`permissions.rule.placeholder.${placeholder(permission)}`),
            })
          )?.trim()
          if (!pattern) return reopen()
          dialog.replace(() => (
            <DialogSelect
              title={pattern}
              options={(["allow", "ask", "deny"] as Action[]).map((action) => ({
                title: locale.t(`permissions.action.${action}`),
                value: action,
              }))}
              onSelect={async (choice) => {
                await sdk.client.permission
                  .rule({ scope: "project", permission, pattern, action: choice.value }, { throwOnError: true })
                  .catch(fail)
                reopen()
              }}
            />
          ))
        }}
      />
    ))

  const select = async (item: Item) => {
    if (item.kind === "mode") {
      local.permissionMode.set(item.mode)
      return
    }
    if (item.kind === "add") return add()
    if (item.kind === "rule") {
      await sdk.client.permission.rule(
        { scope: item.scope, permission: item.permission, pattern: item.pattern },
        { throwOnError: true },
      )
      toast.show({ message: locale.t("permissions.rule.removed"), variant: "info", duration: 2000 })
      refetchRules()
      return
    }
    if (item.kind === "grant") {
      if (!props.sessionID) return
      await sdk.client.permission.revoke({
        sessionID: props.sessionID,
        permission: item.permission,
        pattern: item.pattern,
      })
      toast.show({ message: locale.t("permissions.grant.revoked"), variant: "info", duration: 2000 })
      refetchGrants()
      return
    }
    if (item.action === "install") {
      toast.show({ message: locale.t("permissions.sandbox.installing"), variant: "info", duration: 4000 })
      const res = await sdk.client.sandbox.install()
      refetchSandbox()
      if (res.data?.status !== "on")
        toast.show({
          message: res.data?.reason ?? locale.t("permissions.sandbox.unsupported"),
          variant: "warning",
          duration: 5000,
        })
      return
    }
    if (item.action === "reset") {
      toast.show({ message: locale.t("cli.sandbox.resetting"), variant: "info", duration: 4000 })
      await sdk.client.sandbox.reset(undefined, { throwOnError: true })
      refetchSandbox()
      return
    }
    const enabled = sandbox()?.status !== "off"
    await sdk.client.global.config.update(
      { config: { sandbox: { mode: enabled ? "off" : "preferred" } } },
      { throwOnError: true },
    )
    refetchSandbox()
  }

  return (
    <DialogSelect
      title={locale.t("permissions.title")}
      options={options()}
      skipFilter
      onSelect={(option) => {
        void select(option.value).catch(fail)
        if (option.value.kind === "mode") dialog.clear()
      }}
    />
  )
}
