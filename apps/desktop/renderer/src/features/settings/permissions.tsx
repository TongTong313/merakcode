import Trash2 from "lucide-solid/icons/trash"
import { createSignal, For } from "solid-js"
import type { ConfigPermissionRule } from "@merakcode/sdk"
import { t } from "../../i18n"
import { state, updateConfig } from "../../state/store"
import { Select } from "../../ui/select"
import { toast } from "../../ui/toast"
import { Section } from "./layout"
import { projectRules, ruleFromInput, sameRule, type Decision, type RuleKind } from "./permission-rules"

const fail = (error: Error) => toast({ kind: "error", title: t("error.request", { message: error.message }), error })
const project = () => state.folders[0]?.directory ?? ""

export function Permissions() {
  const [kind, setKind] = createSignal<RuleKind>("bash")
  const [pattern, setPattern] = createSignal("")
  const [decision, setDecision] = createSignal<Decision>("allow")
  const kinds = () => [
    { value: "bash" as const, label: t("settings.rule.bash") },
    { value: "edit" as const, label: t("settings.rule.edit") },
  ]
  const decisions = () => [
    { value: "allow" as const, label: t("settings.rule.allow") },
    { value: "ask" as const, label: t("settings.rule.ask") },
    { value: "deny" as const, label: t("settings.rule.deny") },
  ]
  const all = () => state.config?.permissionRules ?? []
  const rules = () => projectRules(all(), project())
  /** The whole list is replaced: the rules of other projects stay as they are. */
  const write = async (next: ConfigPermissionRule[]) => {
    try {
      await updateConfig({ permissionRules: next })
    } catch (error) {
      fail(error as Error)
    }
  }
  const add = async () => {
    const rule = ruleFromInput(kind(), pattern(), decision(), project())
    if (!rule) return fail(new Error("MRK-3001"))
    setPattern("")
    await write([...all().filter((item) => !sameRule(item, rule)), rule])
  }
  const prefixOf = (rule: ConfigPermissionRule) => rule.commandPrefix ?? rule.pathPrefix ?? ""
  const kindOf = (rule: ConfigPermissionRule) => (rule.commandPrefix ? "bash" : "edit")
  return (
    <Section title={t("settings.permissions")} lead={t("settings.permissionRules.desc")}>
      <div class="section-title">{t("settings.permissionRules")}</div>
      <div class="card">
        <div class="rule-form">
          <Select
            class="chip outlined"
            label={t("settings.rule.kind")}
            options={kinds()}
            value={kind()}
            onChange={setKind}
          />
          <input
            class="input"
            aria-label={t("settings.rule.pattern")}
            placeholder={t("settings.rule.patternPlaceholder")}
            value={pattern()}
            onInput={(event) => setPattern(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && pattern().trim() && void add()}
          />
          <Select
            class="chip outlined"
            label={t("settings.rule.action")}
            options={decisions()}
            value={decision()}
            onChange={setDecision}
          />
          <button class="button primary" disabled={!pattern().trim()} onClick={() => void add()}>
            {t("common.add")}
          </button>
        </div>
        <table class="rules">
          <thead>
            <tr>
              <th>{t("settings.rule.kind")}</th>
              <th>{t("settings.rule.pattern")}</th>
              <th>{t("settings.rule.action")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <For
              each={rules()}
              fallback={
                <tr>
                  <td colSpan={4} class="subtle">
                    {t("settings.rule.empty")}
                  </td>
                </tr>
              }
            >
              {(rule) => (
                <tr>
                  <td>{kinds().find((item) => item.value === kindOf(rule))?.label}</td>
                  <td class="pattern selectable">{prefixOf(rule)}</td>
                  <td>
                    <span
                      class={`badge ${rule.decision === "allow" ? "success" : rule.decision === "deny" ? "danger" : "warning"}`}
                    >
                      {decisions().find((item) => item.value === rule.decision)?.label}
                    </span>
                  </td>
                  <td>
                    <button
                      class="icon-button"
                      aria-label={t("common.remove")}
                      onClick={() => void write(all().filter((item) => !sameRule(item, rule)))}
                    >
                      <Trash2 class="icon icon-sm" />
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Section>
  )
}
