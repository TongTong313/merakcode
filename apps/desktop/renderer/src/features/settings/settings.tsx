import ArrowLeft from "lucide-solid/icons/arrow-left"
import Blocks from "lucide-solid/icons/blocks"
import Brain from "lucide-solid/icons/brain"
import Cpu from "lucide-solid/icons/cpu"
import Eye from "lucide-solid/icons/eye"
import Info from "lucide-solid/icons/info"
import Plug from "lucide-solid/icons/plug"
import Pencil from "lucide-solid/icons/pencil"
import Puzzle from "lucide-solid/icons/puzzle"
import ScrollText from "lucide-solid/icons/scroll-text"
import SettingsIcon from "lucide-solid/icons/settings"
import ShieldCheck from "lucide-solid/icons/shield-check"
import Trash2 from "lucide-solid/icons/trash"
import { createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch as Pick } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { Theme } from "../../desktop/bridge-contract"
import { locale, setLocale, t, toConfig, type Key, type Locale } from "../../i18n"
import { bridge } from "../../lib/bridge"
import type { SandboxStatus } from "@merakcode/sdk/client"
import { call, client } from "../../state/client"
import { available, shownDefaultModel, shownSmallModel } from "../../state/models"
import { loadConfig, loadProviders, setState, state, updateConfig } from "../../state/store"
import { setUi, ui, type SettingsSection } from "../../state/ui"
import { Segmented } from "../../ui/segmented"
import { Select } from "../../ui/select"
import { Switch } from "../../ui/switch"
import { Confirm } from "../../ui/dialog"
import { toast } from "../../ui/toast"
import { trackOverlay } from "../../ui/overlay"
import { modeOptions } from "../conversation/composer"
import { CustomDialog } from "./relay-dialog"
import { updateState } from "../update/state"

const fail = (error: Error) => {
  toast({ kind: "error", title: t("error.request", { message: error.message }), error: error })
}

/** Current project directory; project-level settings are written here */
const project = () => state.folders[0]?.directory

function Section(props: { title: string; lead?: string; children: unknown }) {
  return (
    <section class="settings-inner" role="region" aria-label={props.title}>
      <h1>{props.title}</h1>
      <Show when={props.lead}>
        <p class="lead">{props.lead}</p>
      </Show>
      {props.children as never}
    </section>
  )
}

function Row(props: { label: string; desc?: string; children: unknown }) {
  return (
    <div class="setting-row">
      <div class="grow">
        <div class="label">{props.label}</div>
        <Show when={props.desc}>
          <div class="desc">{props.desc}</div>
        </Show>
      </div>
      {props.children as never}
    </div>
  )
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
        <Row label={t("settings.defaultMode")} desc={t("settings.defaultMode.desc")}>
          <Segmented
            label={t("settings.defaultMode")}
            options={modeOptions()}
            value={state.mode}
            onChange={(mode) => setState("mode", mode)}
          />
        </Row>
      </div>
      <Show when={state.warnings.length}>
        <div class="section-title">{t("settings.warnings")}</div>
        <div class="card">
          <For each={state.warnings}>
            {(warning) => (
              <Row label={warning.item} desc={`${warning.reason} · ${warning.path}`}>
                <button class="button secondary sm" onClick={() => void bridge?.openPath(warning.path)}>
                  {t("settings.warnings.open")}
                </button>
              </Row>
            )}
          </For>
        </div>
      </Show>
    </Section>
  )
}

function Models() {
  const [adding, setAdding] = createSignal(false)
  const [station, setStation] = createSignal<{ id: string; name: string; baseURL: string }>()
  const [editing, setEditing] = createSignal<string>()
  const [key, setKey] = createSignal("")
  const [query, setQuery] = createSignal("")
  const providers = () =>
    (state.providers?.all ?? [])
      .filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(query().toLowerCase()))
      .toSorted(
        (a, b) => Number(state.providers!.connected.includes(b.id)) - Number(state.providers!.connected.includes(a.id)),
      )
  const connect = async (providerID: string) => {
    await call(client(project()).auth.set({ providerID, auth: { type: "api", key: key().trim() } }))
    const result = await call(client(project()).provider.verify({ providerID })).catch((error: Error) => ({
      ok: false,
      message: error.message,
    }))
    const verdict = result as { ok?: boolean; message?: string }
    if (verdict.ok === false)
      toast({ kind: "error", title: t("settings.provider.invalid", { message: verdict.message ?? "" }) })
    else toast({ kind: "success", title: t("settings.provider.verified") })
    setEditing(undefined)
    setKey("")
    await loadProviders(project())
  }
  const disconnect = async (providerID: string) => {
    await call(client(project()).auth.remove({ providerID })).catch(fail)
    await loadProviders(project())
  }
  /** A provider the user added: its config names an API package */
  const custom = (providerID: string) => !!state.config?.provider?.[providerID]?.npm
  const remove = async (providerID: string) => {
    const c = client(project())
    await call(c.global.config.deleteProvider({ providerID }))
    await call(c.auth.remove({ providerID })).catch(() => {})
    await Promise.all([loadConfig(), loadProviders(project())])
  }
  const options = () =>
    available().map((item) => ({
      value: item.key,
      label: item.model.name,
      description: item.provider.name,
      providerID: item.provider.id,
    }))
  return (
    <Section title={t("settings.models")} lead={t("settings.providers.desc")}>
      <div class="card">
        <Row label={t("settings.defaultModel")} desc={t("settings.defaultModel.desc")}>
          <Select
            class="select-field"
            label={t("settings.defaultModel")}
            options={options()}
            value={shownDefaultModel()}
            placeholder={t("model.none")}
            onChange={(model) => void updateConfig({ model }).catch(fail)}
          />
        </Row>
        <Row label={t("settings.smallModel")} desc={t("settings.smallModel.desc")}>
          <Select
            class="select-field"
            label={t("settings.smallModel")}
            options={options()}
            value={shownSmallModel()}
            placeholder={t("settings.smallModel.auto")}
            onChange={(small_model) => void updateConfig({ small_model }).catch(fail)}
          />
        </Row>
      </div>
      <div class="section-title">
        {t("settings.providers")}
        <input
          class="input search"
          placeholder={t("settings.provider.search")}
          aria-label={t("settings.provider.search")}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <button
          class="button secondary sm"
          onClick={() => {
            setStation(undefined)
            setAdding(true)
          }}
        >
          {t("settings.custom.add")}
        </button>
      </div>
      <div class="card">
        <For each={providers().slice(0, 60)}>
          {(provider) => {
            const connected = () => state.providers?.connected.includes(provider.id)
            return (
              <div class="setting-row provider-row">
                <span class={connected() ? "dot success" : "dot"} />
                <div class="grow">
                  <div class="label">{provider.name}</div>
                  <div class="desc">
                    {Object.keys(provider.models).length} · {provider.id}
                  </div>
                  <Show when={editing() === provider.id}>
                    <div class="row key-row">
                      <input
                        class="input"
                        type="password"
                        aria-label={t("settings.provider.key")}
                        placeholder={t("settings.provider.key")}
                        value={key()}
                        onInput={(event) => setKey(event.currentTarget.value)}
                        onKeyDown={(event) =>
                          event.key === "Enter" && key().trim() && void connect(provider.id).catch(fail)
                        }
                        autofocus
                      />
                      <button
                        class="button primary"
                        disabled={!key().trim()}
                        onClick={() => void connect(provider.id).catch(fail)}
                      >
                        {t("settings.provider.verify")}
                      </button>
                    </div>
                  </Show>
                </div>
                <Show
                  when={connected()}
                  fallback={
                    <button
                      class="button secondary sm"
                      onClick={() => setEditing(editing() === provider.id ? undefined : provider.id)}
                    >
                      {t("settings.provider.connect")}
                    </button>
                  }
                >
                  <span class="badge success">{t("settings.provider.connected")}</span>
                  <Show
                    when={custom(provider.id)}
                    fallback={
                      <button class="button ghost sm" onClick={() => void disconnect(provider.id)}>
                        {t("settings.provider.disconnect")}
                      </button>
                    }
                  >
                    <Show when={state.config?.provider?.[provider.id]?.relay}>
                      <button
                        class="button ghost sm"
                        onClick={() => {
                          const current = state.config?.provider?.[provider.id]
                          if (!current?.relay) return
                          setStation({
                            id: current.relay.station,
                            name: provider.name.split(" · ")[0] || provider.name,
                            baseURL: current.api || current.options?.baseURL || "",
                          })
                          setAdding(true)
                        }}
                      >
                        {t("settings.relay.group")}
                      </button>
                    </Show>
                    <button
                      class="icon-button"
                      aria-label={t("settings.removeItem", { name: provider.name })}
                      onClick={() => void remove(provider.id).catch(fail)}
                    >
                      <Trash2 class="icon icon-sm" />
                    </button>
                  </Show>
                </Show>
              </div>
            )
          }}
        </For>
      </div>
      <Show when={adding()}>
        <CustomDialog
          open
          station={station()}
          onClose={() => {
            setAdding(false)
            setStation(undefined)
          }}
        />
      </Show>
    </Section>
  )
}

type Rule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" }

function Permissions() {
  const [rules, { refetch }] = createResource(() => call(client(project()).permission.rules()))
  const [sandbox, { mutate: setSandbox }] = createResource(() =>
    call(client(project()).sandbox.status()).catch(() => undefined),
  )
  const [busy, setBusy] = createSignal<"install" | "reset">()
  /** Windows asks for administrator approval for both; setting up the first time can take minutes */
  const change = async (action: "install" | "reset") => {
    setBusy(action)
    const sdk = client(project()).sandbox
    const status = await call(action === "install" ? sdk.install() : sdk.reset())
      .catch(fail)
      .finally(() => setBusy(undefined))
    if (status) setSandbox(status)
  }
  const describe = (status: SandboxStatus) =>
    status.status === "on"
      ? (status.degraded ?? []).map((item) => t(`settings.sandbox.limit.${item}` as Key)).join(" ")
      : status.installable
        ? t("settings.sandbox.installHint")
        : status.reason
  const [kind, setKind] = createSignal("bash")
  const [pattern, setPattern] = createSignal("")
  const [action, setAction] = createSignal<Rule["action"]>("allow")
  const kinds = () => [
    { value: "bash", label: t("settings.rule.bash") },
    { value: "edit", label: t("settings.rule.edit") },
    { value: "read", label: t("settings.rule.read") },
    { value: "webfetch", label: t("settings.rule.webfetch") },
  ]
  const actions = () => [
    { value: "allow" as const, label: t("settings.rule.allow") },
    { value: "ask" as const, label: t("settings.rule.ask") },
    { value: "deny" as const, label: t("settings.rule.deny") },
  ]
  const save = async (rule: { permission: string; pattern: string; action?: Rule["action"] }) => {
    await call(client(project()).permission.rule({ scope: "project", ...rule })).catch(fail)
    await refetch()
  }
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
          />
          <Select
            class="chip outlined"
            label={t("settings.rule.action")}
            options={actions()}
            value={action()}
            onChange={setAction}
          />
          <button
            class="button primary"
            disabled={!pattern().trim()}
            onClick={() => {
              void save({ permission: kind(), pattern: pattern().trim(), action: action() })
              setPattern("")
            }}
          >
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
              each={rules()?.project ?? []}
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
                  <td>{kinds().find((item) => item.value === rule.permission)?.label ?? rule.permission}</td>
                  <td class="pattern selectable">{rule.pattern}</td>
                  <td>
                    <span
                      class={`badge ${rule.action === "allow" ? "success" : rule.action === "deny" ? "danger" : "warning"}`}
                    >
                      {actions().find((item) => item.value === rule.action)?.label}
                    </span>
                  </td>
                  <td>
                    <button
                      class="icon-button"
                      aria-label={t("common.remove")}
                      onClick={() => void save({ permission: rule.permission, pattern: rule.pattern })}
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
      <Show when={sandbox()}>
        {(status) => (
          <>
            <div class="section-title">{t("settings.sandbox")}</div>
            <div class="card">
              <Row
                label={
                  status().status === "on"
                    ? t("settings.sandbox.on", { backend: status().backend ?? "" })
                    : status().status === "off"
                      ? t("settings.sandbox.off")
                      : t("settings.sandbox.unavailable")
                }
                desc={describe(status())}
              >
                <Show
                  when={status().status !== "on" && status().installable}
                  fallback={<span class={status().status === "on" ? "dot success" : "dot warning"} />}
                >
                  <button class="button primary sm" disabled={!!busy()} onClick={() => void change("install")}>
                    {busy() === "install" ? t("settings.sandbox.installing") : t("settings.sandbox.install")}
                  </button>
                </Show>
              </Row>
              <Show when={status().backend === "windows-account"}>
                <Row label={t("settings.sandbox.reset")} desc={t("settings.sandbox.resetHint")}>
                  <button class="button secondary sm" disabled={!!busy()} onClick={() => void change("reset")}>
                    {busy() === "reset" ? t("settings.sandbox.resetting") : t("settings.sandbox.reset")}
                  </button>
                </Row>
              </Show>
            </div>
          </>
        )}
      </Show>
    </Section>
  )
}

/** Splits a command on whitespace, keeping whitespace inside double quotes */
const words = (text: string) => [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "")

/** One KEY=VALUE per line (headers may also be written as Name: value) */
const pairs = (text: string) =>
  Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const at = line.search(/[=:]/)
      const key = line.slice(0, at).trim()
      return at > 0 && key ? [[key, line.slice(at + 1).trim()]] : []
    }),
  )

type McpChange = Parameters<ReturnType<typeof client>["mcpManagement"]["change"]>[0]["body"]

function Mcp() {
  const [snapshot, { mutate, refetch }] = createResource(() => call(client(project()).mcpManagement.read()))
  const [name, setName] = createSignal("")
  const [target, setTarget] = createSignal("")
  const [extra, setExtra] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  /** Changes the config and reconnects; on failure the engine has already rolled back, so only the reason is shown */
  const change = async (body: McpChange) => {
    const result = await call(client(project()).mcpManagement.change({ body })).catch((error: Error) => ({
      ok: false as const,
      error: { message: error.message },
      snapshot: undefined,
    }))
    if (!result.ok)
      toast({ kind: "error", title: t("error.request", { message: result.error.message }), error: result.error })
    if (result.snapshot) mutate(result.snapshot)
    else await refetch()
    return result.ok
  }
  const add = async () => {
    const value = target().trim()
    const env = pairs(extra())
    const has = Object.keys(env).length > 0
    const config = /^https?:\/\//i.test(value)
      ? { type: "remote" as const, url: value, ...(has ? { headers: env } : {}) }
      : { type: "local" as const, command: words(value), ...(has ? { environment: env } : {}) }
    setBusy(true)
    const ok = await change({ type: "add", name: name().trim(), config }).finally(() => setBusy(false))
    if (!ok) return
    setName("")
    setTarget("")
    setExtra("")
  }
  /** OAuth for a remote server: authorize in the browser, connect once the callback arrives */
  const authorize = async (name: string) => {
    const c = client(project())
    const started = await call(c.mcp.auth.start({ name }))
    await bridge?.openExternal(started.authorizationUrl)
    await call(c.mcp.auth.wait({ name, state: started.oauthState }))
    await refetch()
  }
  const label = (status: string) =>
    ({
      connected: t("settings.mcp.connected"),
      failed: t("settings.mcp.failed"),
      disabled: t("settings.mcp.disabled"),
      needs_auth: t("settings.mcp.needsAuth"),
      needs_client_registration: t("settings.mcp.needsAuth"),
    })[status] ?? status
  const describe = (server: NonNullable<ReturnType<typeof snapshot>>["servers"][number]) =>
    [
      label(server.status.status),
      server.status.status === "connected" ? t("settings.mcp.tools", { count: server.tools.count }) : undefined,
      "error" in server.status ? server.status.error : undefined,
    ]
      .filter(Boolean)
      .join(" · ")
  return (
    <Section title={t("settings.mcp")} lead={t("settings.mcp.desc")}>
      <div class="card">
        <For
          each={snapshot()?.servers ?? []}
          fallback={<div class="setting-row subtle">{t("settings.mcp.empty")}</div>}
        >
          {(server) => (
            <Row label={server.name} desc={describe(server)}>
              <Show when={server.status.status === "needs_auth"}>
                <button class="button secondary sm" onClick={() => void authorize(server.name).catch(fail)}>
                  {t("settings.mcp.authorize")}
                </button>
              </Show>
              <Switch
                label={t("settings.mcp.enable")}
                hideLabel
                checked={server.enabled}
                onChange={(enabled) => void change({ type: "set_enabled", name: server.name, enabled })}
              />
              <button
                class="icon-button"
                aria-label={t("settings.removeItem", { name: server.name })}
                onClick={() => void change({ type: "remove", name: server.name })}
              >
                <Trash2 class="icon icon-sm" />
              </button>
            </Row>
          )}
        </For>
      </div>
      <div class="section-title">{t("settings.mcp.add")}</div>
      <div class="card form">
        <input
          class="input"
          aria-label={t("settings.mcp.name")}
          placeholder={t("settings.mcp.name")}
          value={name()}
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <input
          class="input mono"
          aria-label={t("settings.mcp.target")}
          placeholder={t("settings.mcp.targetPlaceholder")}
          value={target()}
          onInput={(event) => setTarget(event.currentTarget.value)}
        />
        <textarea
          class="input mono"
          rows={2}
          aria-label={t("settings.mcp.env")}
          placeholder={t("settings.mcp.envPlaceholder")}
          value={extra()}
          onInput={(event) => setExtra(event.currentTarget.value)}
        />
        <div class="row end">
          <button
            class="button primary"
            disabled={busy() || !name().trim() || !target().trim()}
            onClick={() => void add()}
          >
            {t("common.add")}
          </button>
        </div>
      </div>
    </Section>
  )
}

type Scope = "project" | "global"

/** Where skills and plugins are installed: for this project only, or for every project */
const scopes = () => [
  { value: "project" as const, label: t("settings.scope.project") },
  { value: "global" as const, label: t("settings.scope.global") },
]
const badges = {
  project: "settings.badge.project",
  global: "settings.badge.global",
  builtin: "settings.badge.builtin",
} as const
const scopeLabel = (scope?: string) => (scope && scope in badges ? t(badges[scope as keyof typeof badges]) : undefined)

type Found = Awaited<ReturnType<typeof listSkills>>
const listSkills = (source: string) => call(client(project()).skillInstall.list({ source }))

function Skills() {
  const [skills, { refetch }] = createResource(() => call(client(project()).app.skills()))
  const [source, setSource] = createSignal("")
  const [scope, setScope] = createSignal<Scope>("project")
  const [found, setFound] = createSignal<Found>()
  const [busy, setBusy] = createSignal(false)
  const [removing, setRemoving] = createSignal<{ name: string; location: string }>()
  const find = async () => {
    setBusy(true)
    const result = await listSkills(source().trim())
      .catch(fail)
      .finally(() => setBusy(false))
    if (!result) return
    setFound(result)
    if (!result.skills.length) toast({ kind: "info", title: t("settings.skills.none") })
  }
  const install = async (skill: Found["skills"][number]) => {
    const result = await call(
      client(project()).skillInstall.install({
        source: found()!.source,
        skills: [skill],
        target: scope(),
        body_directory: project(),
      }),
    ).catch(fail)
    if (!result) return
    for (const item of result.failed) toast({ kind: "error", title: `${item.name}: ${item.error}` })
    if (result.installed.length) toast({ kind: "success", title: t("settings.skills.installed", { name: skill.name }) })
    await refetch()
  }
  const uninstall = async (skill: { name: string; location: string }) => {
    await call(client(project()).skill.uninstall(skill)).catch(fail)
    await refetch()
  }
  const installed = (name: string) => skills()?.some((skill) => skill.name === name && skill.scope !== "builtin")
  return (
    <Section title={t("settings.skills")} lead={t("settings.skills.desc")}>
      <div class="card">
        <For each={skills() ?? []} fallback={<div class="setting-row subtle">{t("settings.skills.empty")}</div>}>
          {(skill) => (
            <Row label={skill.name} desc={skill.description}>
              <Show when={scopeLabel(skill.scope)}>{(label) => <span class="badge neutral">{label()}</span>}</Show>
              <Show when={skill.scope !== "builtin"}>
                <button
                  class="icon-button"
                  aria-label={t("settings.skills.uninstallItem", { name: skill.name })}
                  onClick={() => setRemoving({ name: skill.name, location: skill.location })}
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

function Plugins() {
  // Built-in auth plugins are not user-managed; list only those added in the config
  const [plugins, { refetch }] = createResource(() =>
    call(client(project()).plugin.list()).then((list) => list.filter((plugin) => plugin.source === "config")),
  )
  const [specifier, setSpecifier] = createSignal("")
  const [scope, setScope] = createSignal<Scope>("project")
  const [busy, setBusy] = createSignal(false)
  const label = (status: string) =>
    ({
      active: t("settings.plugins.active"),
      degraded: t("settings.plugins.degraded"),
      failed: t("settings.plugins.failed"),
    })[status] ?? status
  const add = async () => {
    setBusy(true)
    await call(client(project()).plugin.add({ specifier: specifier().trim(), scope: scope() }))
      .then(() => setSpecifier(""))
      .catch(fail)
      .finally(() => setBusy(false))
    await refetch()
  }
  /** The list has no scope: remove from the project config first, then from the global one */
  const remove = async (spec: string) => {
    const c = client(project())
    const removed = await call(c.plugin.remove({ name: spec, scope: "project" }))
    if (!removed) await call(c.plugin.remove({ name: spec, scope: "global" }))
    await refetch()
  }
  return (
    <Section title={t("settings.plugins")} lead={t("settings.plugins.desc")}>
      <div class="card">
        <For each={plugins() ?? []} fallback={<div class="setting-row subtle">{t("settings.plugins.empty")}</div>}>
          {(plugin) => (
            <Row
              label={plugin.id}
              desc={[
                label(plugin.status),
                plugin.tools.length ? t("settings.mcp.tools", { count: plugin.tools.length }) : undefined,
                plugin.error,
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              <span class={plugin.status === "active" ? "dot success" : "dot warning"} />
              <button
                class="icon-button"
                aria-label={t("settings.removeItem", { name: plugin.id })}
                onClick={() => void remove(plugin.spec).catch(fail)}
              >
                <Trash2 class="icon icon-sm" />
              </button>
            </Row>
          )}
        </For>
      </div>
      <div class="section-title">{t("settings.plugins.add")}</div>
      <div class="card form">
        <div class="row">
          <input
            class="input grow mono"
            aria-label={t("settings.plugins.specifier")}
            placeholder={t("settings.plugins.specifierPlaceholder")}
            value={specifier()}
            onInput={(event) => setSpecifier(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && specifier().trim() && void add()}
          />
          <Select
            class="chip outlined"
            label={t("settings.scope")}
            options={scopes()}
            value={scope()}
            onChange={setScope}
          />
          <button class="button primary" disabled={busy() || !specifier().trim()} onClick={() => void add()}>
            {t("common.add")}
          </button>
        </div>
      </div>
    </Section>
  )
}

/** Rule editor; the caller closes it after a successful save */
function RuleEditor(props: {
  label: string
  text: string
  rows: number
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = createSignal(props.text)
  return (
    <div class="setting-row rule-editor">
      <textarea
        class="input mono"
        rows={props.rows}
        aria-label={props.label}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
        autofocus
      />
      <div class="row end">
        <button class="button ghost sm" onClick={() => props.onCancel()}>
          {t("common.cancel")}
        </button>
        <button class="button primary sm" disabled={!text().trim()} onClick={() => props.onSave(text())}>
          {t("common.save")}
        </button>
      </div>
    </div>
  )
}

type RuleChange = Parameters<ReturnType<typeof client>["ruleManagement"]["change"]>[0]["body"]

function Rules() {
  const [snapshot, { mutate, refetch }] = createResource(() => call(client(project()).ruleManagement.read()))
  // Creating a file needs the targets from the snapshot; before it loads, a click on New did nothing at all
  const loaded = () => snapshot.state === "ready" || snapshot.state === "refreshing"
  const [draft, setDraft] = createSignal("")
  const [filename, setFilename] = createSignal("")
  /** Entry being edited: user:<index> for a personal rule, the file path for a rule file */
  const [editing, setEditing] = createSignal<string>()
  const change = async (body: RuleChange) => {
    const result = await call(client(project()).ruleManagement.change({ body })).catch((error: Error) => ({
      ok: false as const,
      error: { message: error.message },
      snapshot: undefined,
    }))
    if (!result.ok)
      toast({ kind: "error", title: t("error.request", { message: result.error.message }), error: result.error })
    if (result.snapshot) mutate(result.snapshot)
    else await refetch()
    return result.ok
  }
  const save = async (body: RuleChange) => {
    if (await change(body)) setEditing(undefined)
  }
  const add = async () => {
    if (await change({ type: "user_add", text: draft() })) setDraft("")
  }
  /**
   * Instruction files such as AGENTS.md are created in the project root, anything else as .mdc under
   * .merakcode/rules; the new file opens for editing right away
   */
  const create = async () => {
    const name = filename().trim()
    const kind = /\.md$/i.test(name) ? "instruction" : "native"
    const target = snapshot()?.targets.find((item) => item.kind === kind)
    if (!target) return
    const before = new Set(snapshot()?.files.map((file) => file.filepath))
    if (!(await change({ type: "file_create", targetId: target.id, filename: name }))) return
    setFilename("")
    setEditing(snapshot()?.files.find((file) => !before.has(file.filepath))?.filepath)
  }
  const base = (filepath: string) => filepath.split(/[\\/]/).pop() ?? filepath
  const types = {
    always: "settings.rules.always",
    auto: "settings.rules.auto",
    "agent-requested": "settings.rules.requested",
    manual: "settings.rules.manual",
  } as const
  return (
    <Section title={t("settings.rules")} lead={t("settings.rules.desc")}>
      <div class="section-title">{t("settings.rules.user")}</div>
      <div class="card">
        <For each={snapshot()?.user ?? []}>
          {(rule) => {
            const key = `user:${rule.index}`
            const name = () => t("settings.rules.userItem", { n: rule.index + 1 })
            return (
              <Show
                when={editing() === key}
                fallback={
                  <div class="setting-row">
                    <div class="grow rule-text">{rule.text}</div>
                    <button
                      class="icon-button"
                      aria-label={t("settings.editItem", { name: name() })}
                      onClick={() => setEditing(key)}
                    >
                      <Pencil class="icon icon-sm" />
                    </button>
                    <button
                      class="icon-button"
                      aria-label={t("settings.removeItem", { name: name() })}
                      onClick={() => void change({ type: "user_remove", index: rule.index })}
                    >
                      <Trash2 class="icon icon-sm" />
                    </button>
                  </div>
                }
              >
                <RuleEditor
                  label={name()}
                  text={rule.text}
                  rows={3}
                  onSave={(text) => void save({ type: "user_update", index: rule.index, text })}
                  onCancel={() => setEditing(undefined)}
                />
              </Show>
            )
          }}
        </For>
        <div class="setting-row">
          <textarea
            class="input grow"
            rows={2}
            aria-label={t("settings.rules.new")}
            placeholder={t("settings.rules.newPlaceholder")}
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
          <button class="button primary" disabled={!draft().trim()} onClick={() => void add()}>
            {t("common.add")}
          </button>
        </div>
      </div>
      <div class="section-title">{t("settings.rules.project")}</div>
      <div class="card">
        <For each={snapshot()?.files ?? []}>
          {(file) => (
            <Show
              when={editing() === file.filepath}
              fallback={
                <div class="setting-row">
                  <div class="grow">
                    <div class="label mono">{file.label}</div>
                    <div class="desc">
                      {[file.type ? t(types[file.type]) : undefined, file.description, file.problem]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <Show when={file.scope === "global"}>
                    <span class="badge neutral">{t("settings.badge.global")}</span>
                  </Show>
                  <Show when={file.editable && !file.clipped}>
                    <button
                      class="icon-button"
                      aria-label={t("settings.editItem", { name: base(file.filepath) })}
                      onClick={() => setEditing(file.filepath)}
                    >
                      <Pencil class="icon icon-sm" />
                    </button>
                  </Show>
                  <Show when={file.removable}>
                    <button
                      class="icon-button"
                      aria-label={t("settings.removeItem", { name: base(file.filepath) })}
                      onClick={() => void change({ type: "file_delete", filepath: file.filepath })}
                    >
                      <Trash2 class="icon icon-sm" />
                    </button>
                  </Show>
                </div>
              }
            >
              <RuleEditor
                label={base(file.filepath)}
                text={file.content}
                rows={12}
                onSave={(content) => void save({ type: "file_write", filepath: file.filepath, content })}
                onCancel={() => setEditing(undefined)}
              />
            </Show>
          )}
        </For>
        <div class="setting-row">
          <input
            class="input grow mono"
            aria-label={t("settings.rules.filename")}
            placeholder={t("settings.rules.filenamePlaceholder")}
            value={filename()}
            onInput={(event) => setFilename(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && filename().trim() && loaded() && void create()}
          />
          <button class="button secondary" disabled={!filename().trim() || !loaded()} onClick={() => void create()}>
            {t("settings.rules.create")}
          </button>
        </div>
      </div>
    </Section>
  )
}

function Memory() {
  const [snapshot, { refetch }] = createResource(() => call(client(project()).memory.list()))
  const [open, setOpen] = createSignal<{ path: string; content: string }>()
  const view = async (path: string) => {
    if (open()?.path === path) return setOpen(undefined)
    setOpen(await call(client(project()).memory.read({ path })))
  }
  const remove = async (path: string) => {
    await call(client(project()).memory.remove({ path })).catch(fail)
    if (open()?.path === path) setOpen(undefined)
    await refetch()
  }
  const types = {
    user: "settings.memory.user",
    feedback: "settings.memory.feedback",
    project: "settings.memory.project",
    reference: "settings.memory.reference",
  } as const
  const typeLabel = (type?: string) => (type && type in types ? t(types[type as keyof typeof types]) : undefined)
  return (
    <Section title={t("settings.memory")} lead={t("settings.memory.desc")}>
      <div class="card">
        <Row label={t("settings.memory.auto")} desc={t("settings.memory.autoDesc")}>
          <Switch
            label={t("settings.memory.auto")}
            hideLabel
            checked={state.config?.memory?.auto_extract !== false}
            onChange={(on) => void updateConfig({ memory: { auto_extract: on ? "signals" : false } }).catch(fail)}
          />
        </Row>
        <Row label={t("settings.memory.folder")} desc={snapshot()?.directory}>
          <Show when={snapshot()?.entries.length}>
            <button class="button secondary sm" onClick={() => void bridge?.openPath(snapshot()!.directory)}>
              {t("settings.memory.open")}
            </button>
          </Show>
        </Row>
      </div>
      <div class="card">
        <For
          each={snapshot()?.entries ?? []}
          fallback={<div class="setting-row subtle">{t("settings.memory.empty")}</div>}
        >
          {(entry) => {
            const name = entry.name ?? entry.filename
            return (
              <>
                <div class="setting-row">
                  <div class="grow">
                    <div class="label">{name}</div>
                    <div class="desc">{entry.description}</div>
                  </div>
                  <Show when={typeLabel(entry.type)}>{(label) => <span class="badge neutral">{label()}</span>}</Show>
                  <button
                    class="icon-button"
                    aria-label={t("settings.memory.view", { name })}
                    aria-expanded={open()?.path === entry.path}
                    onClick={() => void view(entry.path).catch(fail)}
                  >
                    <Eye class="icon icon-sm" />
                  </button>
                  <button
                    class="icon-button"
                    aria-label={t("settings.removeItem", { name })}
                    onClick={() => void remove(entry.path)}
                  >
                    <Trash2 class="icon icon-sm" />
                  </button>
                </div>
                <Show when={open()?.path === entry.path}>
                  <pre class="memory-body selectable">{open()?.content}</pre>
                </Show>
              </>
            )
          }}
        </For>
      </div>
    </Section>
  )
}

function About() {
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
  { id: "permissions", label: () => t("settings.permissions"), icon: ShieldCheck, view: Permissions },
  { id: "mcp", label: () => t("settings.mcp"), icon: Plug, view: Mcp },
  { id: "skills", label: () => t("settings.skills"), icon: Puzzle, view: Skills },
  { id: "plugins", label: () => t("settings.plugins"), icon: Blocks, view: Plugins },
  { id: "rules", label: () => t("settings.rules"), icon: ScrollText, view: Rules },
  { id: "memory", label: () => t("settings.memory"), icon: Brain, view: Memory },
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
