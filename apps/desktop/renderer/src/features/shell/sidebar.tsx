import type { Session } from "@merakcode/sdk/client"
import CircleHelp from "lucide-solid/icons/circle-question-mark"
import Ellipsis from "lucide-solid/icons/ellipsis"
import FolderOpen from "lucide-solid/icons/folder-open"
import FolderPlus from "lucide-solid/icons/folder-plus"
import GitBranch from "lucide-solid/icons/git-branch"
import LoaderCircle from "lucide-solid/icons/loader-circle"
import Plus from "lucide-solid/icons/plus"
import Users from "lucide-solid/icons/users"
import Search from "lucide-solid/icons/search"
import Settings from "lucide-solid/icons/settings"
import ArrowUpCircle from "lucide-solid/icons/circle-arrow-up"
import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { A, useNavigate } from "@solidjs/router"
import { ago, t } from "../../i18n"
import { bridge, mac } from "../../lib/bridge"
import { baseName, sameDir, sessionPath } from "../../lib/route"
import { call, client } from "../../state/client"
import { unsavedReason } from "../../state/git"
import { closeFolder, listen, loadMore, openFolder, sessionsOf, state, statusOf, type Folder } from "../../state/store"
import { setUi, ui } from "../../state/ui"
import { updateState } from "../update/state"
import { Confirm } from "../../ui/dialog"
import { Menu } from "../../ui/menu"
import { toast } from "../../ui/toast"
import { Rename } from "./rename"
import { GroupCreate } from "../conversation/group-create"
import { releaseBuffers } from "../code/state"

const mod = mac ? "⌘" : "Ctrl"

/** Picks a folder and opens it as a project */
export async function pickFolder(navigate: (path: string) => void) {
  const picked = await bridge?.openDirectoryPicker({ title: t("sidebar.openProject") })
  const directory = Array.isArray(picked) ? picked[0] : picked
  if (!directory) return
  await openFolder(directory)
  navigate(sessionPath(directory))
}

function Status(props: { status: ReturnType<typeof statusOf> }) {
  return (
    <span class="status" data-state={props.status}>
      <Switch fallback={<span class="dot" />}>
        <Match when={props.status === "running"}>
          <LoaderCircle class="icon icon-sm spinner" />
        </Match>
        <Match when={props.status === "approval"}>
          <span class="dot warning" />
        </Match>
        <Match when={props.status === "question"}>
          <CircleHelp class="icon icon-sm" />
        </Match>
      </Switch>
    </span>
  )
}

function GroupNames(props: { sessionID: string; directory: string }) {
  const [names, setNames] = createSignal("")
  const load = () => {
    void call(client(props.directory).collaboration.get({ sessionID: props.sessionID, directory: props.directory }))
      .then((group) => setNames(group.seats.map((seat) => seat.name).join("、")))
      .catch(() => undefined)
  }
  onMount(() => {
    load()
    onCleanup(
      listen((_directory, event) => {
        if (event.type === "collaboration.updated" && event.properties.sessionID === props.sessionID) load()
      }),
    )
  })
  return (
    <Show when={names()}>
      <span class="ellipsis">{names()}</span>
    </Show>
  )
}

function Conversation(props: { session: Session; folder: Folder; current?: string }) {
  const navigate = useNavigate()
  const [deleting, setDeleting] = createSignal(false)
  const [renaming, setRenaming] = createSignal(false)
  const status = () => statusOf(props.session.id)
  /** A conversation running in a worktree shows its branch */
  const worktree = () =>
    props.folder.project?.vcs === "git" && !sameDir(props.session.directory, props.folder.directory)
  const label = () =>
    ({ running: t("status.running"), approval: t("status.approval"), question: t("status.question"), idle: "" })[
      status()
    ]
  const c = () => client(props.session.directory)
  const remove = async () => {
    setDeleting(false)
    await call(c().session.delete({ sessionID: props.session.id })).catch((error: Error) =>
      toast({ kind: "error", title: error.message, error }),
    )
    if (props.current === props.session.id) navigate(sessionPath(props.folder.directory))
  }
  return (
    <div class="conversation-row">
      <A
        href={sessionPath(props.folder.directory, props.session.id)}
        class="conversation"
        aria-current={props.current === props.session.id ? "page" : undefined}
      >
        <Status status={status()} />
        <span class="body">
          <span class="title">
            {props.session.title || t("sidebar.untitled")}
            <Show when={props.session.metadata?.group === true}>
              <span class="chip group-chip">
                <Users class="icon icon-xs" />
                {t("sidebar.groupMark")}
              </span>
            </Show>
          </span>
          <span class="meta">
            <Show when={label()}>
              <span class="state" data-state={status()}>
                {label()}
              </span>
            </Show>
            <Show when={worktree()}>
              <GitBranch class="icon icon-xs" />
              <span class="ellipsis">{state.branch[props.session.directory] ?? t("sidebar.worktree")}</span>
            </Show>
            <Show when={props.session.metadata?.group === true}>
              <GroupNames sessionID={props.session.id} directory={props.session.directory} />
            </Show>
          </span>
        </span>
        <span class="time">{ago(props.session.time.updated)}</span>
      </A>
      <Menu
        class="icon-button sm row-menu"
        label={t("sidebar.conversationMenu")}
        trigger={<Ellipsis class="icon icon-sm" />}
        items={[
          { label: t("sidebar.rename"), onSelect: () => setRenaming(true) },
          { label: t("sidebar.delete"), danger: true, onSelect: () => setDeleting(true) },
        ]}
      />
      <Rename session={props.session} open={renaming()} onClose={() => setRenaming(false)} />
      <Confirm
        open={deleting()}
        title={t("sidebar.deleteConfirm", { title: props.session.title })}
        description={t("sidebar.deleteDetail")}
        confirm={t("sidebar.delete")}
        cancel={t("common.cancel")}
        danger
        onResult={(ok) => (ok ? void remove() : setDeleting(false))}
      />
    </div>
  )
}

function Group(props: { folder: Folder; current?: string; route?: string }) {
  const navigate = useNavigate()
  const name = () => baseName(props.folder.directory)
  const list = () => sessionsOf(props.folder)
  const remove = () => {
    const directory = props.folder.directory
    const directories = [directory, ...(props.folder.project?.sandboxes ?? [])]
    const reason = directories.map(unsavedReason).find(Boolean)
    if (reason) return void toast({ kind: "info", title: reason })
    for (const value of directories) if (!releaseBuffers(value)) return
    const openHere = props.route !== undefined && sameDir(props.route, directory)
    closeFolder(directory)
    if (!openHere) return
    const next = state.folders[0]
    navigate(next ? sessionPath(next.directory) : "/")
  }
  return (
    <section class="group" aria-label={name()}>
      <div class="group-title">
        <FolderOpen class="icon icon-sm" />
        <span class="ellipsis">{name()}</span>
        <span class="count">{list().length || ""}</span>
        <Menu
          class="icon-button sm row-menu"
          label={t("sidebar.projectMenu")}
          trigger={<Ellipsis class="icon icon-sm" />}
          items={[
            {
              label: t("sidebar.newIn", { name: name() }),
              icon: Plus,
              onSelect: () => navigate(sessionPath(props.folder.directory)),
            },
            "separator",
            { label: t("sidebar.removeProject"), onSelect: remove },
          ]}
        />
      </div>
      <For each={list()} fallback={<div class="group-empty subtle">{t("sidebar.empty")}</div>}>
        {(session) => <Conversation session={session} folder={props.folder} current={props.current} />}
      </For>
      <Show when={props.folder.more}>
        <button class="button ghost sm more" onClick={() => void loadMore(props.folder.directory)}>
          {t("sidebar.more")}
        </button>
      </Show>
    </section>
  )
}

/** A new version is out: one line above the settings button that opens About & updates */
function UpdateNotice() {
  const text = () => {
    const state = updateState()
    if (state.kind === "available") return t("update.notice.available", { version: state.version })
    if (state.kind === "ready") return t("update.notice.ready", { version: state.version })
    if (state.kind === "manual") return t("update.notice.manual", { version: state.version })
    return undefined
  }
  return (
    <Show when={text()}>
      {(label) => (
        <button class="nav-row update-notice" onClick={() => setUi("settings", "about")}>
          <ArrowUpCircle class="icon" />
          <span class="ellipsis">{label()}</span>
        </button>
      )}
    </Show>
  )
}

/** Sidebar: new conversation, search, conversations grouped by project (with run status), settings */
export function Sidebar(props: { directory?: string; current?: string }) {
  const navigate = useNavigate()
  const directory = () => props.directory ?? state.folders[0]?.directory
  const newConversation = () => {
    const dir = directory()
    if (dir) navigate(sessionPath(dir))
    else void pickFolder(navigate)
  }
  return (
    <nav class="sidebar" aria-label={t("sidebar.label")}>
      <div class="sidebar-top drag">
        <div class="brand">
          <img src="/logo.svg" alt="" />
          {t("app.name")}
        </div>
      </div>
      <div class="sidebar-actions">
        <button class="nav-row" onClick={newConversation}>
          <Plus class="icon" />
          {t("sidebar.new")}
          <kbd aria-hidden="true">{mod} N</kbd>
        </button>
        <button class="nav-row" disabled={!directory()} onClick={() => setUi("newTeam", true)}>
          <Users class="icon" />
          {t("sidebar.group")}
          <kbd aria-hidden="true">{mod} G</kbd>
        </button>
        <button class="nav-row" onClick={() => setUi("palette", true)}>
          <Search class="icon" />
          {t("sidebar.search")}
          <kbd aria-hidden="true">{mod} K</kbd>
        </button>
      </div>
      <div class="sidebar-scroll scroll">
        <For each={state.folders}>
          {(folder) => <Group folder={folder} current={props.current} route={props.directory} />}
        </For>
      </div>
      <UpdateNotice />
      <div class="sidebar-bottom">
        <button class="nav-row grow" onClick={() => setUi("settings", "general")}>
          <Settings class="icon" />
          {t("sidebar.settings")}
        </button>
        <button
          class="icon-button"
          aria-label={t("sidebar.openProject")}
          title={t("sidebar.openProject")}
          onClick={() => void pickFolder(navigate)}
        >
          <FolderPlus class="icon" />
        </button>
      </div>
      <Show when={directory()}>
        {(dir) => (
          <GroupCreate
            directory={dir()}
            open={ui.newTeam}
            onClose={() => setUi("newTeam", false)}
            onCreated={(sessionID) => navigate(sessionPath(dir(), sessionID))}
          />
        )}
      </Show>
    </nav>
  )
}
