import Trash2 from "lucide-solid/icons/trash"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import type { ConfigMCPServer, McpStatus } from "@merakcode/sdk"
import { t } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { client } from "../../state/client"
import { listen, state, updateConfig } from "../../state/store"
import { Switch } from "../../ui/switch"
import { toast } from "../../ui/toast"
import { Row, Section } from "./layout"
import { mcpDefinition } from "./mcp-input"

const fail = (error: Error) => toast({ kind: "error", title: t("error.request", { message: error.message }), error })
const project = () => state.folders[0]?.directory

const label = (status: string) =>
  ({
    connected: t("settings.mcp.connected"),
    failed: t("settings.mcp.failed"),
    disabled: t("settings.mcp.disabled"),
    needs_auth: t("settings.mcp.needsAuth"),
  })[status] ?? status

const describe = (server: McpStatus) =>
  [
    label(server.status),
    server.status === "connected" ? t("settings.mcp.tools", { count: server.tools }) : undefined,
    server.code,
  ]
    .filter(Boolean)
    .join(" · ")

export function Mcp() {
  const [servers, { refetch }] = createResource(async () =>
    ((await (await client()).mcp.status({ directory: project() })) ?? []).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    ),
  )
  onCleanup(listen((_directory, event) => event.type === "mcp.changed" && void refetch()))
  const [name, setName] = createSignal("")
  const [target, setTarget] = createSignal("")
  const [extra, setExtra] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  /** Changes one entry of the configuration; the engine reads it again and the list follows. */
  const change = async (entries: Record<string, ConfigMCPServer | null>) => {
    try {
      await updateConfig({ mcp: entries })
      await refetch()
      return true
    } catch (error) {
      fail(error as Error)
      return false
    }
  }
  const add = async () => {
    setBusy(true)
    const ok = await change({ [name().trim()]: mcpDefinition(target(), extra()) }).finally(() => setBusy(false))
    if (!ok) return
    setName("")
    setTarget("")
    setExtra("")
  }
  const setEnabled = (server: string, enabled: boolean) => {
    const current = state.config?.mcpServers?.[server]
    if (!current) return
    void change({ [server]: { ...current, disabled: !enabled } })
  }
  /** OAuth for a remote server: log in in the browser; the engine says when the login is done. */
  const authorize = async (server: string) => {
    const { url } = await (await client()).mcp.authenticate({ server })
    await bridge?.openExternal(url)
  }
  return (
    <Section title={t("settings.mcp")} lead={t("settings.mcp.desc")}>
      <div class="card">
        <For each={servers() ?? []} fallback={<div class="setting-row subtle">{t("settings.mcp.empty")}</div>}>
          {(server) => (
            <Row label={server.name} desc={describe(server)}>
              <Show when={server.status === "needs_auth"}>
                <button class="button secondary sm" onClick={() => void authorize(server.name).catch(fail)}>
                  {t("settings.mcp.authorize")}
                </button>
              </Show>
              <Switch
                label={t("settings.mcp.enable")}
                hideLabel
                checked={server.status !== "disabled"}
                onChange={(enabled) => setEnabled(server.name, enabled)}
              />
              <button
                class="icon-button"
                aria-label={t("settings.removeItem", { name: server.name })}
                onClick={() => void change({ [server.name]: null })}
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
