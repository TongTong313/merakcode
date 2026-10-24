import FileDiff from "lucide-solid/icons/file-diff"
import FolderPlus from "lucide-solid/icons/folder-plus"
import MessageSquare from "lucide-solid/icons/message-square"
import PanelRight from "lucide-solid/icons/panel-right"
import Plus from "lucide-solid/icons/plus"
import Settings from "lucide-solid/icons/settings"
import SquareTerminal from "lucide-solid/icons/square-terminal"
import TextSearch from "lucide-solid/icons/text-search"
import Users from "lucide-solid/icons/users"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useLocation, useNavigate } from "@solidjs/router"
import type { SessionSearchResult } from "@merakcode/sdk/client"
import { t } from "../../i18n"
import { baseName, decodeDir, sessionPath } from "../../lib/route"
import { call, client } from "../../state/client"
import { sessionsOf, state, type Folder } from "../../state/store"
import { setUi, togglePanel, ui } from "../../state/ui"
import { Dialog } from "../../ui/dialog"
import { openReview } from "../review/state"
import { pickFolder } from "../shell/sidebar"

type Item = {
  id: string
  label: string
  detail?: string
  icon: (props: { class?: string }) => JSX.Element
  group: string
  run: () => void
}

type Found = SessionSearchResult & { folder: Folder }

/** Root conversations of the open projects whose text contains term, looked up on the engine */
async function searchContent(term: string) {
  const lists = await Promise.all(
    state.folders.map(async (folder) => {
      const project = folder.project
      if (!project) return []
      const results = await call(
        client(folder.directory).session.search({
          search: term,
          roots: true,
          limit: 10,
          ...(project.id === "global" ? { directory: folder.directory } : {}),
        }),
      ).catch(() => [])
      return results.filter((item) => item.match).map((item) => ({ ...item, folder }))
    }),
  )
  return lists.flat()
}

/** Command palette (Ctrl/⌘+K): search conversations (titles and content) and commands, arrow keys to select, Enter to run */
export function Palette() {
  const navigate = useNavigate()
  const location = useLocation()
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const [found, setFound] = createSignal<Found[]>([])
  const directory = () => decodeDir(location.pathname.split("/")[1] ?? "") || state.folders[0]?.directory

  // Content is searched a moment after typing stops; an answer to an older query is dropped
  createEffect(() => {
    const term = query().trim()
    setFound([])
    if (!term) return
    let stale = false
    const timer = setTimeout(() => void searchContent(term).then((items) => stale || setFound(items)), 200)
    onCleanup(() => {
      stale = true
      clearTimeout(timer)
    })
  })

  const items = createMemo<Item[]>(() => {
    const commands: Item[] = [
      {
        id: "new",
        label: t("palette.cmd.new"),
        icon: Plus,
        group: t("palette.commands"),
        run: () => directory() && navigate(sessionPath(directory()!)),
      },
      {
        id: "team",
        label: t("sidebar.group"),
        icon: Users,
        group: t("palette.commands"),
        run: () => directory() && setUi("newTeam", true),
      },
      {
        id: "settings",
        label: t("palette.cmd.settings"),
        icon: Settings,
        group: t("palette.commands"),
        run: () => setUi("settings", "general"),
      },
      {
        id: "terminal",
        label: t("palette.cmd.terminal"),
        icon: SquareTerminal,
        group: t("palette.commands"),
        run: () => setUi("terminal", true),
      },
      { id: "panel", label: t("palette.cmd.panel"), icon: PanelRight, group: t("palette.commands"), run: togglePanel },
      {
        id: "review",
        label: t("palette.cmd.review"),
        icon: FileDiff,
        group: t("palette.commands"),
        run: () => openReview(),
      },
      {
        id: "open",
        label: t("palette.cmd.openProject"),
        icon: FolderPlus,
        group: t("palette.commands"),
        run: () => void pickFolder(navigate),
      },
    ]
    const conversations: Item[] = state.folders.flatMap((folder) =>
      sessionsOf(folder)
        .slice(0, 50)
        .map((session) => ({
          id: session.id,
          label: session.title || t("sidebar.untitled"),
          detail: baseName(folder.directory),
          icon: MessageSquare,
          group: t("palette.conversations"),
          run: () => navigate(sessionPath(folder.directory, session.id)),
        })),
    )
    const words = query().toLowerCase().split(/\s+/).filter(Boolean)
    const match = (item: Item) =>
      words.every((word) => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(word))
    const titled = conversations.filter(match)
    const shown = new Set(titled.map((item) => item.id))
    const content: Item[] = found()
      .filter((item) => !shown.has(item.session.id))
      .map((item) => ({
        id: `content-${item.session.id}`,
        label: item.session.title || t("sidebar.untitled"),
        detail: item.match!.text,
        icon: TextSearch,
        group: t("palette.content"),
        run: () => navigate(sessionPath(item.folder.directory, item.session.id)),
      }))
    return [...commands.filter(match), ...titled, ...content]
  })

  const close = () => {
    setUi("palette", false)
    setQuery("")
    setActive(0)
  }
  const run = (item: Item | undefined) => {
    if (!item) return
    close()
    item.run()
  }
  const key = (event: KeyboardEvent) => {
    if (event.isComposing) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      setActive((index) => Math.min(Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)), items().length - 1))
      document.getElementById(`palette-${active()}`)?.scrollIntoView({ block: "nearest" })
    }
    if (event.key === "Enter") {
      event.preventDefault()
      run(items()[active()])
    }
  }

  return (
    <Dialog
      open={ui.palette}
      onOpenChange={(open) => (open ? setUi("palette", true) : close())}
      title={t("palette.label")}
      hideTitle
      class="palette"
    >
      <input
        class="palette-input"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={items().length ? `palette-${active()}` : undefined}
        aria-label={t("palette.placeholder")}
        placeholder={t("palette.placeholder")}
        value={query()}
        onInput={(event) => {
          setQuery(event.currentTarget.value)
          setActive(0)
        }}
        onKeyDown={key}
        autofocus
      />
      <div class="palette-list scroll" id="palette-list" role="listbox" aria-label={t("palette.label")}>
        <Show when={items().length} fallback={<div class="empty-state subtle">{t("palette.empty")}</div>}>
          <For each={items()}>
            {(item, index) => (
              <>
                <Show when={index() === 0 || items()[index() - 1]!.group !== item.group}>
                  <div class="menu-group-label">{item.group}</div>
                </Show>
                <div
                  id={`palette-${index()}`}
                  class="menu-item"
                  role="option"
                  aria-selected={index() === active()}
                  data-highlighted={index() === active() ? "" : undefined}
                  onMouseEnter={() => setActive(index())}
                  onClick={() => run(item)}
                >
                  <Dynamic component={item.icon} class="icon icon-sm muted" />
                  <span class="ellipsis">{item.label}</span>
                  <Show when={item.detail}>
                    <span class="desc ellipsis">{item.detail}</span>
                  </Show>
                </div>
              </>
            )}
          </For>
        </Show>
      </div>
    </Dialog>
  )
}
