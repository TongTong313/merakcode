import ArrowLeft from "lucide-solid/icons/arrow-left"
import Cpu from "lucide-solid/icons/cpu"
import Info from "lucide-solid/icons/info"
import SettingsIcon from "lucide-solid/icons/settings"
import { createSignal, For, Match, onCleanup, onMount, Switch as Pick } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { Theme } from "../../desktop/bridge-contract"
import { locale, setLocale, t, toConfig, type Locale } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { state, updateConfig } from "../../state/store"
import { PermissionModeSelect } from "../conversation/permission-mode"
import { onConnection } from "../../state/client"
import { setUi, ui, type SettingsSection } from "../../state/ui"
import { Segmented } from "../../ui/segmented"
import { Select } from "../../ui/select"
import { toast } from "../../ui/toast"
import { trackOverlay } from "../../ui/overlay"
import { updateState } from "../update/state"
import { Row, Section } from "./layout"
import { Models } from "./models"
import { Profiles } from "./profiles"
import { Cloud } from "./cloud"

const fail = (error: Error) => {
  toast({ kind: "error", title: t("error.request", { message: error.message }), error: error })
}

function General() {
  const [theme, setTheme] = createSignal<Theme>("system")
  onMount(() => void bridge?.getTheme().then(setTheme))
  const changeLocale = async (next: Locale) => {
    setLocale(next)
    void bridge?.setLocale(next)
    await updateConfig({ locale: toConfig(next) }).catch(fail)
  }
  return (
    <Section title={t("settings.general")}>
      <div class="card">
        <Row label={t("permissionLevel.label")} desc={t("permissionLevel.default.desc")}>
          <PermissionModeSelect
            value={state.config?.mode ?? "ask"}
            onChange={(mode) => void updateConfig({ mode }).catch(fail)}
          />
        </Row>
        <Row label={t("settings.language")} desc={t("settings.language.desc")}>
          <Select
            class="chip outlined"
            label={t("settings.language")}
            options={[
              { value: "zh", label: "中文" },
              { value: "en", label: "English" },
            ]}
            value={locale()}
            onChange={(value) => void changeLocale(value)}
          />
        </Row>
        <Row label={t("settings.theme")} desc={t("settings.theme.desc")}>
          <Segmented
            label={t("settings.theme")}
            options={[
              { value: "system", label: t("settings.theme.system") },
              { value: "light", label: t("settings.theme.light") },
              { value: "dark", label: t("settings.theme.dark") },
            ]}
            value={theme()}
            onChange={(value) => {
              setTheme(value)
              void bridge?.setTheme(value)
            }}
          />
        </Row>
      </div>
    </Section>
  )
}

function About() {
  const [engineVersion, setEngineVersion] = createSignal<string>()
  const [exporting, setExporting] = createSignal(false)
  onMount(() => onCleanup(onConnection((connection) => setEngineVersion(connection?.hello.engine))))
  const exportBundle = async () => {
    setExporting(true)
    try {
      if (await bridge?.exportDiagnostics()) toast({ kind: "success", title: t("settings.about.exported") })
    } catch (error) {
      toast({ kind: "error", title: t("settings.about.diagnostics"), error })
    } finally {
      setExporting(false)
    }
  }
  const update = () => updateState()
  const desc = () => {
    const state = update()
    const current = t("settings.about.version", { version: bridge?.version ?? "dev" })
    const note = (() => {
      if (state.kind === "checking") return t("settings.about.checking")
      if (state.kind === "latest") return t("settings.about.latest")
      if (state.kind === "available") return t("settings.about.available", { version: state.version })
      if (state.kind === "ready") return t("settings.about.ready", { version: state.version })
      if (state.kind === "manual")
        return t(`settings.about.manual.${state.reason ?? "linux-package"}`, { version: state.version })
      if (state.kind === "error") return t("settings.about.error", { code: state.code, message: state.message })
      if (state.kind === "unavailable") return t(`settings.about.unavailable.${state.reason}`)
      return undefined
    })()
    return note ? `${current} · ${note}` : current
  }
  return (
    <Section title={t("settings.about")}>
      <div class="card">
        <Row label={t("app.name")} desc={desc()}>
          <Pick
            fallback={
              <button
                class="button secondary sm"
                disabled={update().kind === "checking"}
                onClick={() => void bridge?.checkForUpdates()}
              >
                {t("settings.about.check")}
              </button>
            }
          >
            <Match when={update().kind === "ready"}>
              <button class="button primary sm" onClick={() => void bridge?.installUpdate()}>
                {t("settings.about.install")}
              </button>
            </Match>
            <Match when={update().kind === "downloading" && update()}>
              {(state) => (
                <span class="muted">
                  {t("settings.about.downloading", { percent: (state() as { percent: number }).percent })}
                </span>
              )}
            </Match>
            <Match when={update().kind === "available" && update()}>
              {(state) => (
                <button class="button primary sm" onClick={() => void bridge?.startUpdateDownload()}>
                  {t("settings.about.download", { version: (state() as { version: string }).version })}
                </button>
              )}
            </Match>
            <Match when={update().kind === "manual"}>
              <button class="button primary sm" onClick={() => void bridge?.startUpdateDownload()}>
                {t("settings.about.manual")}
              </button>
            </Match>
          </Pick>
        </Row>
        <Row label={t("settings.about.engine", { version: engineVersion() ?? "—" })}>{null}</Row>
        <Row label={t("settings.about.diagnostics")}>
          <button class="button secondary sm" disabled={exporting() || !bridge} onClick={() => void exportBundle()}>
            {t("settings.about.diagnostics")}
          </button>
        </Row>
        <Row label={t("settings.about.logs")}>
          <button class="button secondary sm" onClick={() => void bridge?.openLogDirectory()}>
            {t("settings.about.logs")}
          </button>
        </Row>
      </div>
    </Section>
  )
}

const SECTIONS: { id: SettingsSection; label: () => string; icon: typeof Cpu; view: () => unknown }[] = [
  { id: "general", label: () => t("settings.general"), icon: SettingsIcon, view: General },
  { id: "models", label: () => t("settings.models"), icon: Cpu, view: Models },
  { id: "profiles", label: () => t("profiles.title"), icon: Cpu, view: Profiles },
  { id: "cloud", label: () => t("cloud.title"), icon: SettingsIcon, view: Cloud },
  { id: "about", label: () => t("settings.about"), icon: Info, view: About },
]

/** Settings: covers the whole window with categories on the left; Esc or "Back" closes it */
export function Settings() {
  trackOverlay(() => !!ui.settings)
  onMount(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (document.querySelector("[data-kb-popper-content-wrapper], [role=dialog]")) return
      setUi("settings", undefined)
    }
    window.addEventListener("keydown", listener)
    onCleanup(() => window.removeEventListener("keydown", listener))
  })
  const current = () => SECTIONS.find((section) => section.id === ui.settings) ?? SECTIONS[0]!
  return (
    <div class="settings-layer app">
      <nav class="settings-nav" aria-label={t("settings.title")}>
        <button class="back drag-none" onClick={() => setUi("settings", undefined)}>
          <ArrowLeft class="icon icon-sm" />
          {t("settings.back")}
        </button>
        <For each={SECTIONS}>
          {(section) => (
            <button
              class="nav-row"
              aria-current={current().id === section.id ? "page" : undefined}
              onClick={() => setUi("settings", section.id)}
            >
              <section.icon class="icon" />
              {section.label()}
            </button>
          )}
        </For>
      </nav>
      <main class="main">
        <div class="topbar drag">
          <span class="title">{t("settings.title")}</span>
        </div>
        <div class="settings-body scroll">
          <Dynamic component={current().view as () => never} />
        </div>
      </main>
    </div>
  )
}
