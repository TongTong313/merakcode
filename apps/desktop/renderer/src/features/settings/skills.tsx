import Trash2 from "lucide-solid/icons/trash"
import { createResource, createSignal, For, Show } from "solid-js"
import type { SkillOffer } from "@merakcode/sdk"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { state } from "../../state/store"
import { Confirm } from "../../ui/dialog"
import { Select } from "../../ui/select"
import { toast } from "../../ui/toast"
import { Row, Section } from "./layout"

type Scope = "project" | "global"

const fail = (error: Error) => toast({ kind: "error", title: t("error.request", { message: error.message }), error })
const project = () => state.folders[0]?.directory

const scopes = () => [
  { value: "project" as const, label: t("settings.scope.project") },
  { value: "global" as const, label: t("settings.scope.global") },
]
const badges = {
  project: "settings.badge.project",
  global: "settings.badge.global",
  builtin: "settings.badge.builtin",
} as const
const scopeLabel = (source?: string) =>
  source && source in badges ? t(badges[source as keyof typeof badges]) : undefined

/** What the person installs a skill from, and what the engine found there. */
type Found = { source: string; skills: SkillOffer[] }

export function Skills() {
  const [skills, { refetch }] = createResource(async () => {
    const result = await (await client()).skill.list({ directory: project() })
    return result.skills ?? []
  })
  const [source, setSource] = createSignal("")
  const [scope, setScope] = createSignal<Scope>("project")
  const [found, setFound] = createSignal<Found>()
  const [busy, setBusy] = createSignal(false)
  const [removing, setRemoving] = createSignal<{ name: string; source: string }>()
  const find = async () => {
    setBusy(true)
    try {
      const offers = (await (await client()).skill.discover({ source: source().trim() })) ?? []
      setFound({ source: source().trim(), skills: offers })
      if (!offers.length) toast({ kind: "info", title: t("settings.skills.none") })
    } catch (error) {
      fail(error as Error)
    } finally {
      setBusy(false)
    }
  }
  const install = async (skill: SkillOffer) => {
    try {
      await (
        await client()
      ).skill.install({ source: found()!.source, names: [skill.name], scope: scope(), directory: project() })
      toast({ kind: "success", title: t("settings.skills.installed", { name: skill.name }) })
      await refetch()
    } catch (error) {
      fail(error as Error)
    }
  }
  const uninstall = async (skill: { name: string; source: string }) => {
    try {
      await (await client()).skill.uninstall({ name: skill.name, scope: skill.source, directory: project() })
      await refetch()
    } catch (error) {
      fail(error as Error)
    }
  }
  const installed = (name: string) => skills()?.some((skill) => skill.name === name && skill.source !== "builtin")
  return (
    <Section title={t("settings.skills")} lead={t("settings.skills.desc")}>
      <div class="card">
        <For each={skills() ?? []} fallback={<div class="setting-row subtle">{t("settings.skills.empty")}</div>}>
          {(skill) => (
            <Row label={skill.name} desc={skill.description}>
              <Show when={scopeLabel(skill.source)}>{(label) => <span class="badge neutral">{label()}</span>}</Show>
              <Show when={skill.source !== "builtin"}>
                <button
                  class="icon-button"
                  aria-label={t("settings.skills.uninstallItem", { name: skill.name })}
                  onClick={() => setRemoving({ name: skill.name, source: skill.source })}
                >
                  <Trash2 class="icon icon-sm" />
                </button>
              </Show>
            </Row>
          )}
        </For>
      </div>
      <div class="section-title">{t("settings.skills.add")}</div>
      <div class="card form">
        <div class="row">
          <input
            class="input grow"
            aria-label={t("settings.skills.source")}
            placeholder={t("settings.skills.sourcePlaceholder")}
            value={source()}
            onInput={(event) => setSource(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && source().trim() && void find()}
          />
          <Select
            class="chip outlined"
            label={t("settings.scope")}
            options={scopes()}
            value={scope()}
            onChange={setScope}
          />
          <button class="button secondary" disabled={busy() || !source().trim()} onClick={() => void find()}>
            {t("settings.skills.find")}
          </button>
        </div>
        <For each={found()?.skills ?? []}>
          {(skill) => (
            <Row label={skill.name} desc={skill.description}>
              <button
                class="button secondary sm"
                aria-label={t("settings.skills.installItem", { name: skill.name })}
                disabled={installed(skill.name)}
                onClick={() => void install(skill)}
              >
                {installed(skill.name) ? t("settings.skills.installedBadge") : t("settings.skills.install")}
              </button>
            </Row>
          )}
        </For>
      </div>
      <Confirm
        open={!!removing()}
        title={t("settings.skills.uninstallTitle", { name: removing()?.name ?? "" })}
        description={t("settings.skills.uninstallDetail")}
        confirm={t("settings.skills.uninstall")}
        cancel={t("common.cancel")}
        danger
        onResult={(ok) => {
          const skill = removing()
          setRemoving(undefined)
          if (ok && skill) void uninstall(skill)
        }}
      />
    </Section>
  )
}
