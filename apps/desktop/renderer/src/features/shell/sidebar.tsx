import Bot from "lucide-solid/icons/bot"
import CircleHelp from "lucide-solid/icons/circle-question-mark"
import House from "lucide-solid/icons/house"
import ListChecks from "lucide-solid/icons/list-checks"
import Ellipsis from "lucide-solid/icons/ellipsis"
import FolderOpen from "lucide-solid/icons/folder-open"
import FolderPlus from "lucide-solid/icons/folder-plus"
import LoaderCircle from "lucide-solid/icons/loader-circle"
import Plus from "lucide-solid/icons/plus"
import Users from "lucide-solid/icons/users"
import Search from "lucide-solid/icons/search"
import Settings from "lucide-solid/icons/settings"
import ArrowUpCircle from "lucide-solid/icons/circle-arrow-up"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import { A, useNavigate } from "@solidjs/router"
import { ago, t } from "../../i18n"
import { bridge, mac } from "../../lib/bridge"
import { baseName, groupPath, sameDir, sessionPath, taskPath } from "../../lib/route"
import { groups, groupView, loadGroups, unreadGroup } from "../../state/groups"
import type { GroupGroup, TaskCard, TaskStatus } from "@merakcode/sdk"
import { createdAt, taskUpdated, tasks } from "../../state/tasks"
import { TaskCreate } from "../tasks/create"
import { entriesOf, type Entry } from "./entries"
import { GroupCreate } from "../conversation/group-create"
import { unsavedReason } from "../../state/git"
import {
  closeFolder,
  hideSession,
  type SessionSummary,
  openFolder,
  conversations,
  session as conversationOf,
  state,
  statusOf,
  type Folder,
} from "../../state/store"
import { setUi, ui } from "../../state/ui"
import { updateState } from "../update/state"
import { Confirm } from "../../ui/dialog"
import { Menu } from "../../ui/menu"
import { toast } from "../../ui/toast"
import { Rename } from "./rename"
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

function Conversation(props: { session: SessionSummary; folder: Folder; current?: string }) {
  const navigate = useNavigate()
  const [deleting, setDeleting] = createSignal(false)
  const [renaming, setRenaming] = createSignal(false)
  const status = () => statusOf(props.session.id)
  const label = () =>
    ({ running: t("status.running"), approval: t("status.approval"), question: t("status.question"), idle: "" })[
      status()
    ]
  const remove = async () => {
    await hideSession(props.session.id)
    setDeleting(false)
    if (props.current === props.session.id) navigate(sessionPath(props.folder.directory))
  }
  return (
    <div class="conversation-row">
      <A
        href={sessionPath(props.folder.directory, props.session.id)}
        class="conversation"
        data-entry={`session:${props.session.id}`}
        aria-current={props.current === props.session.id ? "page" : undefined}
      >
        <Status status={status()} />
        <span class="body">
          <span class="title">{props.session.title || t("sidebar.untitled")}</span>
          <span class="meta">
            <Show when={label()}>
              <span class="state" data-state={status()}>
                {label()}
              </span>
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
          { label: t("sidebar.hide"), danger: true, onSelect: () => setDeleting(true) },
        ]}
      />
      <Rename session={props.session} open={renaming()} onClose={() => setRenaming(false)} />
      <Confirm
        open={deleting()}
        title={t("sidebar.hideConfirm", { title: props.session.title })}
        description={t("sidebar.hideDetail")}
        confirm={t("sidebar.hide")}
        cancel={t("common.cancel")}
        danger
        onResult={(ok) =>
          ok
            ? void remove().catch((error: Error) => toast({ kind: "error", title: error.message, error }))
            : setDeleting(false)
        }
      />
    </div>
  )
}

function GroupLink(props: { group: GroupGroup; current?: string }) {
  const names = () =>
    groupView(props.group.id)
      ?.members.filter((member) => member.kind === "agent")
      .map((member) => member.name)
      .join("、")
  return (
    <A
      class="conversation"
      data-entry={`group:${props.group.id}`}
      href={groupPath(props.group.project.directory, props.group.id)}
      aria-current={props.current === props.group.id ? "page" : undefined}
    >
      <Users class="icon icon-sm" />
      <span class="body">
        <span class="title">{props.group.name}</span>
        <span class="meta ellipsis" title={names()}>
          {names()}
        </span>
      </span>
      <Show when={unreadGroup(props.group.id)}>
        <span class="count" data-unread-group={props.group.id}>
          {unreadGroup(props.group.id)}
        </span>
      </Show>
    </A>
  )
}

function TaskLink(props: { task: TaskCard; current?: string }) {
  return (
    <A
      class="conversation"
      data-entry={`task:${props.task.id}`}
      href={taskPath(props.task.id)}
      aria-current={props.current === props.task.id ? "page" : undefined}
    >
      <ListChecks class="icon icon-sm" />
      <span class="body">
        <span class="title">{props.task.title}</span>
        <span class="meta">{t(`task.status.${props.task.status as TaskStatus}`)}</span>
      </span>
      <span class="time">{ago(taskUpdated(props.task.id))}</span>
    </A>
  )
}

function Group(props: {
  folder: Folder
  entries: Entry[]
  current?: string
  route?: string
  group?: string
  task?: string
}) {
  const navigate = useNavigate()
  const name = () => baseName(props.folder.directory)
  const listed = () => state.folders.some((folder) => sameDir(folder.directory, props.folder.directory))
  const remove = async () => {
    const directory = props.folder.directory
    const directories = [directory]
    const reason = directories.map(unsavedReason).find(Boolean)
    if (reason) return void toast({ kind: "info", title: reason })
    for (const value of directories) if (!releaseBuffers(value)) return
    const openHere = props.route !== undefined && sameDir(props.route, directory)
    try {
      await closeFolder(directory)
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: "MRK-5001" }), error })
      return
    }
    if (!openHere) return
    const next = state.folders[0]
    navigate(next ? sessionPath(next.directory) : "/")
  }
  return (
    <section class="group" aria-label={name()}>
      <div class="group-title">
        <FolderOpen class="icon icon-sm" />
        <span class="ellipsis" title={props.folder.directory}>
          {name()}
        </span>
        <span class="count">{props.entries.length || ""}</span>
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
            ...(listed() ? (["separator", { label: t("sidebar.removeProject"), onSelect: remove }] as const) : []),
          ]}
        />
      </div>
      <Show when={!props.entries.length}>
        <div class="group-empty subtle">{t("sidebar.empty")}</div>
      </Show>
      <For each={props.entries}>
        {(entry) => (
          <Switch>
            <Match when={entry.kind === "group" && entry}>
              {(item) => <GroupLink group={item().group} current={props.group} />}
            </Match>
            <Match when={entry.kind === "task" && entry}>
              {(item) => <TaskLink task={item().task} current={props.task} />}
            </Match>
            <Match when={entry.kind === "session" && entry}>
              {(item) => (
                <Conversation session={conversationOf(item().id)!} folder={props.folder} current={props.current} />
              )}
            </Match>
          </Switch>
        )}
      </For>
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

/**
 * The folders the sidebar shows: the ones the person opened, then any other folder that has a group or a task of its
 * own, so work is never hidden because its folder was taken off the list.
 */
function workspaces(): Folder[] {
  const opened = state.folders
  const others = [...groups().map((group) => group.project.directory), ...tasks().map((task) => task.project)]
    .filter((directory) => directory && !opened.some((folder) => sameDir(folder.directory, directory)))
    .filter((directory, index, all) => all.findIndex((other) => sameDir(other, directory)) === index)
  return [...opened, ...others.map((directory) => ({ directory }))]
}

/** Sidebar: the five entries, then every workspace with its groups, tasks and conversations, settings */
export function Sidebar(props: { directory?: string; current?: string; group?: string; task?: string }) {
  const navigate = useNavigate()
  const directory = () => props.directory ?? state.folders[0]?.directory
  const newConversation = () => {
    const dir = directory()
    if (dir) navigate(sessionPath(dir))
    else void pickFolder(navigate)
  }
  const entries = (folder: Folder) =>
    entriesOf(folder.directory, {
      groups: groups(),
      tasks: tasks(),
      sessions: conversations(),
      updated: (kind, id) => (kind === "group" ? groupView(id)?.updated || createdAt(id) : taskUpdated(id)),
    })
  return (
    <nav class="sidebar" aria-label={t("sidebar.label")}>
      <div class="sidebar-top drag">
        <div class="brand">
          <img src="/logo.svg" alt="" />
          {t("app.name")}
        </div>
      </div>
      <div class="sidebar-actions">
        <A href="/" end class="nav-row">
          <House class="icon" />
          {t("sidebar.home")}
        </A>

        <button class="nav-row" onClick={newConversation}>
          <Plus class="icon" />
          {t("sidebar.new")}
          <kbd aria-hidden="true">{mod} N</kbd>
        </button>

        <button class="nav-row" onClick={() => navigate("/agents?new=1")}>
          <Bot class="icon" />
          {t("sidebar.agent")}
        </button>

        <button class="nav-row" onClick={() => setUi("newTeam", true)}>
          <Users class="icon" />
          {t("sidebar.group")}
          <kbd aria-hidden="true">{mod} G</kbd>
        </button>

        <button class="nav-row" onClick={() => setUi("newTask", true)}>
          <ListChecks class="icon" />
          {t("sidebar.task")}
        </button>

        <button class="nav-row" onClick={() => setUi("palette", true)}>
          <Search class="icon" />
          {t("sidebar.search")}
          <kbd aria-hidden="true">{mod} K</kbd>
        </button>
      </div>
      <div class="sidebar-scroll scroll">
        <Show when={!state.folders.length}>
          <Show when={!workspaces().length}>
            <div class="group-empty subtle">{t("sidebar.noWorkspace")}</div>
          </Show>
          <button class="nav-row" onClick={() => void pickFolder(navigate)}>
            <FolderOpen class="icon" />
            {t("sidebar.openFolder")}
          </button>
        </Show>
        <For each={workspaces()}>
          {(folder) => (
            <Group
              folder={folder}
              entries={entries(folder)}
              current={props.current}
              route={props.directory}
              group={props.group}
              task={props.task}
            />
          )}
        </For>
      </div>
      <GroupCreate
        directory={directory() ?? ""}
        open={ui.newTeam}
        onClose={() => setUi("newTeam", false)}
        onCreated={(group) => {
          void loadGroups()
            .then(() => navigate(groupPath(group.project.directory, group.id)))
            .catch((error) => toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error }))
        }}
      />
      <TaskCreate
        directory={directory()}
        open={ui.newTask}
        onClose={() => setUi("newTask", false)}
        onCreated={(task) => navigate(taskPath(task.id))}
      />
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
    </nav>
  )
}
