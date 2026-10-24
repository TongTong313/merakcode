import FolderOpen from "lucide-solid/icons/folder-open"
import { createEffect, createMemo, createResource, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { Navigate, Route, Router, useLocation, useNavigate, useParams } from "@solidjs/router"
import { t } from "./i18n"
import { bridge, log, mac } from "./lib/bridge"
import { decodeDir, sessionPath } from "./lib/route"
import { bootstrap, connect, openFolder, state } from "./state/store"
import { restoreLayout, setUi, togglePanel, ui } from "./state/ui"
import { toast, Toasts } from "./ui/toast"
import { Compose } from "./features/conversation/compose"
import { Conversation } from "./features/conversation/page"
import { Onboarding } from "./features/onboarding/onboarding"
import { Palette } from "./features/palette/palette"
import { Settings } from "./features/settings/settings"
import { Notify } from "./features/shell/notify"
import { pickFolder, Sidebar } from "./features/shell/sidebar"
import { Startup } from "./features/shell/startup"

/** Global shortcuts, ⌘/Ctrl plus: K palette, N new conversation, G new team, "," settings, J terminal, B side panel */
function Shortcuts() {
  const navigate = useNavigate()
  const location = useLocation()
  const directory = () => decodeDir(location.pathname.split("/")[1] ?? "") || state.folders[0]?.directory
  onMount(() => {
    const listener = (event: KeyboardEvent) => {
      const command = mac ? event.metaKey : event.ctrlKey
      if (!command || event.altKey || event.isComposing) return
      const key = event.key.toLowerCase()
      if (key === "k") setUi("palette", !ui.palette)
      else if (key === "n" && directory()) navigate(sessionPath(directory()!))
      else if (key === "g" && directory()) setUi("newTeam", true)
      else if (key === ",") setUi("settings", "general")
      else if (key === "j") setUi("terminal", !ui.terminal)
      else if (key === "b") togglePanel()
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", listener)
    onCleanup(() => window.removeEventListener("keydown", listener))
    // Actions from the tray and the menu
    const stops = [
      bridge?.onNavigate((href) => navigate(href)),
      bridge?.onNavigateNewSession(() => directory() && navigate(sessionPath(directory()!))),
      bridge?.onOpenSettings(() => setUi("settings", "general")),
    ]
    onCleanup(() => stops.forEach((stop) => stop?.()))
  })
  return null
}

/** Invalid config entries: each new one is announced once; "View" opens settings to show the file and entry */
function Warnings() {
  const seen = new Set<string>()
  createEffect(() => {
    const fresh = state.warnings.filter((item) => !seen.has(`${item.path}|${item.item}|${item.reason}`))
    if (!fresh.length) return
    for (const item of fresh) seen.add(`${item.path}|${item.item}|${item.reason}`)
    toast({
      kind: "error",
      title: t("config.warnings", { count: state.warnings.length }),
      detail: `${fresh[0]!.item}：${fresh[0]!.reason}`,
      action: { label: t("config.view"), run: () => setUi("settings", "general") },
    })
  })
  return null
}

function Root(props: { children?: JSX.Element }) {
  const [ready, { refetch }] = createResource(async () => {
    await Promise.all([bootstrap(), restoreLayout()])
    return true
  })
  onMount(() => onCleanup(connect()))
  createEffect(() => ready.error && log("error", "bootstrap failed", { error: String(ready.error) }))
  return (
    <>
      <Startup ready={ready} onRetry={() => void refetch()}>
        {props.children}
        <Shortcuts />
        <Warnings />
        <Notify />
        <Palette />
        <Onboarding />
        <Show when={ui.settings}>
          <Settings />
        </Show>
      </Startup>
      <Show when={!state.connected && ready.state === "ready"}>
        <div class="connection" role="status">
          {t("connection.lost")}
        </div>
      </Show>
      <Toasts />
    </>
  )
}

/** Home: opens the most recent project, or asks the user to open a folder when there is none */
export function Home() {
  const navigate = useNavigate()
  return (
    <Show
      when={state.folders[0]}
      fallback={
        <div class="app">
          <Sidebar />
          <main class="main">
            <div class="topbar drag" />
            <div class="compose-page">
              <h1 class="compose-heading">{t("home.title")}</h1>
              <p class="muted">{t("home.lead")}</p>
              <button class="button primary lg" onClick={() => void pickFolder(navigate)}>
                <FolderOpen class="icon" />
                {t("home.open")}
              </button>
            </div>
          </main>
        </div>
      }
    >
      {(folder) => <Navigate href={sessionPath(folder().directory)} />}
    </Show>
  )
}

/** Inside a project: the sidebar plus a new or existing conversation */
export function Workspace() {
  const params = useParams()
  const directory = createMemo(() => decodeDir(params.dir ?? ""))
  // The route decides which project is open. Reading the sidebar list must not subscribe this effect,
  // or removing the open project puts it straight back.
  createEffect(() => {
    const dir = directory()
    if (!dir) return
    untrack(() => {
      void openFolder(dir).catch((error: Error) => log("error", "open folder failed", { error: error.message }))
    })
  })
  return (
    <Show when={directory()} fallback={<Navigate href="/" />}>
      {(dir) => (
        <div class="app">
          <Show when={!ui.maximized}>
            <Sidebar directory={dir()} current={params.id} />
          </Show>
          <Show when={params.id} keyed fallback={<Compose directory={dir()} />}>
            {(id) => <Conversation id={id} directory={dir()} />}
          </Show>
        </div>
      )}
    </Show>
  )
}

export function App() {
  return (
    <Router root={Root}>
      <Route path="/" component={Home} />
      <Route path="/:dir/session/:id?" component={Workspace} />
      <Route path="*" component={() => <Navigate href="/" />} />
    </Router>
  )
}
