import { createEffect, createMemo, createResource, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { Navigate, Route, Router, useLocation, useNavigate, useParams } from "@solidjs/router"
import { t } from "./i18n"
import { bridge, log, mac } from "./lib/bridge"
import { decodeDir, sessionPath } from "./lib/route"
import { bootstrap, connect, listen, openFolder, session, state } from "./state/store"
import { restoreLayout, setUi, togglePanel, ui } from "./state/ui"
import { openPanel, releasePanels } from "./features/panel/workspace"
import { CloseEditor } from "./features/panel/close"
import { toast, Toasts } from "./ui/toast"
import { Compose } from "./features/conversation/compose"
import { Conversation } from "./features/conversation/page"
import { Onboarding } from "./features/onboarding/onboarding"
import { Palette } from "./features/palette/palette"
import { Settings } from "./features/settings/settings"
import { freshWarnings } from "./features/settings/warnings"
import { Notify } from "./features/shell/notify"
import { Sidebar } from "./features/shell/sidebar"
import { Startup } from "./features/shell/startup"
import { StartPage } from "./features/start/page"
import { AgentsPage } from "./features/agents/agents"
import { TaskBoardPage } from "./features/tasks/board"
import { TaskPage } from "./features/tasks/page"
import { GroupConversation } from "./features/conversation/group-page"
import { connectGroups, loadGroups } from "./state/groups"
import { connectImport } from "./state/import"
import { connectTasks } from "./state/tasks"

/** Global shortcuts, ⌘/Ctrl plus: K palette, N new conversation, G new group, "," settings, J terminal, B side panel */
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
      else if (key === "g") setUi("newTeam", true)
      else if (key === ",") setUi("settings", "general")
      else if (key === "j") {
        setUi("panel", true)
        void openPanel({ kind: "terminal" }, true)
      } else if (key === "b") togglePanel()
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener("keydown", listener, true)
    onCleanup(() => window.removeEventListener("keydown", listener, true))
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

/** Entries of the configuration that were skipped: each new one is announced once; "View" opens the list in settings. */
function Warnings() {
  const seen = new Set<string>()
  createEffect(() => {
    const warnings = state.config?.warnings ?? []
    const fresh = freshWarnings(warnings, seen)
    if (!fresh.length) return
    toast({
      kind: "error",
      title: t("config.warnings", { count: warnings.length }),
      detail: fresh[0]!.path,
      action: { label: t("config.view"), run: () => setUi("settings", "general") },
    })
  })
  return null
}

/** Frees the panel resources of a conversation that was archived or removed; a failure offers a retry. */
function release(directory: string, sessionID: string, deleted: boolean) {
  void releasePanels({ directory, sessionID }, deleted).catch((error: unknown) =>
    toast({
      kind: "error",
      title: t("error.request", { message: String(error) }),
      error,
      action: { label: t("panel.retry"), run: () => release(directory, sessionID, deleted) },
    }),
  )
}

function Root(props: { children?: JSX.Element }) {
  const [ready, { refetch }] = createResource(async () => {
    await Promise.all([bootstrap(), restoreLayout(), loadGroups()])
    return true
  })
  onMount(() => onCleanup(connect()))
  onMount(() =>
    onCleanup(
      listen((directory, event) => {
        const sessionID = event.type === "session.updated" && event.payload.archived ? event.scope.session : undefined
        if (sessionID) release(directory, sessionID, false)
      }),
    ),
  )
  // A removed conversation never comes back, so its panels, terminals and drafts are released for good
  createEffect(
    on(
      () => [...state.hidden],
      (ids, previous = []) => {
        for (const id of ids.filter((value) => !previous.includes(value)))
          release(session(id)?.directory ?? "", id, true)
      },
      { defer: true },
    ),
  )
  onMount(() => onCleanup(connectGroups()))
  onMount(() => onCleanup(connectTasks()))
  onMount(() => onCleanup(connectImport()))
  createEffect(() => ready.error && log("error", "bootstrap failed", { error: String(ready.error) }))
  return (
    <>
      <Startup ready={ready} onRetry={() => void refetch()}>
        {props.children}
        <Shortcuts />
        <CloseEditor />
        <Notify />
        <Warnings />
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

export { StartPage as Home }

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
      <Route path="/" component={StartPage} />
      <Route path="/agents" component={AgentsPage} />
      <Route path="/tasks" component={TaskBoardPage} />
      <Route path="/task/:id" component={TaskPage} />
      <Route path="/:dir/session/:id?" component={Workspace} />
      <Route path="/:dir/group/:id" component={GroupWorkspace} />
      <Route path="*" component={() => <Navigate href="/" />} />
    </Router>
  )
}

function GroupWorkspace() {
  const params = useParams()
  const directory = () => decodeDir(params.dir ?? "")
  return (
    <Show when={directory()} fallback={<Navigate href="/" />}>
      {(dir) => (
        <div class="app">
          <Show when={!ui.maximized}>
            <Sidebar directory={dir()} group={params.id} />
          </Show>
          <GroupConversation id={params.id!} directory={dir()} />
        </div>
      )}
    </Show>
  )
}
