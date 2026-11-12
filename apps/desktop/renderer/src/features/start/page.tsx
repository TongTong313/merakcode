import Bot from "lucide-solid/icons/bot"
import FolderOpen from "lucide-solid/icons/folder-open"
import MessageSquarePlus from "lucide-solid/icons/message-square-plus"
import Users from "lucide-solid/icons/users"
import { useNavigate } from "@solidjs/router"
import { createMemo, For, Show } from "solid-js"
import { ago, t } from "../../i18n"
import { groupPath, sessionPath, taskPath } from "../../lib/route"
import { groups, groupView } from "../../state/groups"
import { conversations, state } from "../../state/store"
import { createdAt, tasks } from "../../state/tasks"
import { setUi } from "../../state/ui"
import { pickFolder, Sidebar } from "../shell/sidebar"
import { TaskColumns } from "../tasks/board"
import { HomeInbox } from "./inbox"

type Recent = { key: string; title: string; subtitle: string; href: string; updated: number; kind: "group" | "session" }

/** The most recent groups and conversations, whichever changed last first. */
function recent(): Recent[] {
  return [
    ...groups()
      .filter((group) => !group.archived)
      .map((group): Recent => {
        const updated = groupView(group.id)?.updated || createdAt(group.id)
        return {
          key: `group:${group.id}`,
          title: group.name,
          subtitle: group.project.directory,
          href: groupPath(group.project.directory, group.id),
          updated,
          kind: "group",
        }
      }),
    ...conversations().map((item): Recent => ({
      key: `session:${item.id}`,
      title: item.title || t("sidebar.untitled"),
      subtitle: item.directory,
      href: sessionPath(item.directory, item.id),
      updated: item.time.updated,
      kind: "session",
    })),
  ]
    .toSorted((a, b) => b.updated - a.updated)
    .slice(0, 6)
}

/** Home: what is waiting for this person, every unfinished task, and where they worked last. */
export function StartPage() {
  const navigate = useNavigate()
  const latest = createMemo(recent)
  const empty = () => !latest().length && !tasks().length && !state.folders.length
  return (
    <div class="app">
      <Sidebar />
      <main class="main">
        <div class="topbar drag">
          <span class="title">{t("home.heading")}</span>
        </div>
        <div class="home scroll">
          <Show
            when={!empty()}
            fallback={
              <div class="compose-page">
                <h1 class="compose-heading">{t("home.title")}</h1>
                <p class="muted">{t("home.lead")}</p>
                <button class="button primary lg" onClick={() => void pickFolder(navigate)}>
                  <FolderOpen class="icon" />
                  {t("home.open")}
                </button>
              </div>
            }
          >
            <h1 class="sr-only">{t("home.heading")}</h1>
            <div class="home-inner">
              <section class="home-section">
                <h2>{t("home.inbox")}</h2>
                <HomeInbox />
              </section>
              <section class="home-section">
                <div class="row">
                  <h2>{t("home.board")}</h2>
                  <span class="spacer" />
                  <button class="button ghost sm" onClick={() => navigate("/tasks")}>
                    {t("home.expand")}
                  </button>
                </div>
                <Show
                  when={tasks().some((task) => !["done", "failed", "cancelled"].includes(task.status))}
                  fallback={<p class="subtle">{t("home.boardEmpty")}</p>}
                >
                  <TaskColumns onOpen={(id) => navigate(taskPath(id))} />
                </Show>
              </section>
              <section class="home-section">
                <h2>{t("home.recent")}</h2>
                <Show
                  when={latest().length}
                  fallback={
                    <div class="home-quick">
                      <p class="subtle">{t("home.recentEmpty")}</p>
                      <div class="row">
                        <button
                          class="button secondary"
                          onClick={() => {
                            const folder = state.folders[0]
                            if (folder) navigate(sessionPath(folder.directory))
                            else void pickFolder(navigate)
                          }}
                        >
                          <MessageSquarePlus class="icon icon-sm" />
                          {t("home.quickChat")}
                        </button>
                        <button class="button secondary" onClick={() => navigate("/agents?new=1")}>
                          <Bot class="icon icon-sm" />
                          {t("home.quickAgent")}
                        </button>
                        <button class="button secondary" onClick={() => setUi("newTeam", true)}>
                          <Users class="icon icon-sm" />
                          {t("home.quickGroup")}
                        </button>
                      </div>
                    </div>
                  }
                >
                  <div class="home-recent">
                    <For each={latest()}>
                      {(item) => (
                        <a
                          class="home-recent-row"
                          href={item.href}
                          data-recent={item.key}
                          onClick={(event) => {
                            event.preventDefault()
                            navigate(item.href)
                          }}
                        >
                          <Show when={item.kind === "group"} fallback={<MessageSquarePlus class="icon icon-sm" />}>
                            <Users class="icon icon-sm" />
                          </Show>
                          <span class="ellipsis">{item.title}</span>
                          <span class="subtle ellipsis">{item.subtitle}</span>
                          <span class="spacer" />
                          <span class="subtle">{ago(item.updated)}</span>
                        </a>
                      )}
                    </For>
                  </div>
                </Show>
              </section>
            </div>
          </Show>
        </div>
      </main>
    </div>
  )
}
