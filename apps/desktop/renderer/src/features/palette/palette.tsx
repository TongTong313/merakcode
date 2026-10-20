import FileDiff from "lucide-solid/icons/file-diff"
import FolderPlus from "lucide-solid/icons/folder-plus"
import MessageSquare from "lucide-solid/icons/message-square"
import PanelRight from "lucide-solid/icons/panel-right"
import Plus from "lucide-solid/icons/plus"
import Settings from "lucide-solid/icons/settings"
import SquareTerminal from "lucide-solid/icons/square-terminal"
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useLocation, useNavigate } from "@solidjs/router"
import { t } from "../../i18n"
import { baseName, decodeDir, sessionPath } from "../../lib/route"
import { sessionsOf, state } from "../../state/store"
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

/** Command palette (Ctrl/⌘+K): search conversations and commands, arrow keys to select, Enter to run */
export function Palette() {
  const navigate = useNavigate()
  const location = useLocation()
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const directory = () => decodeDir(location.pathname.split("/")[1] ?? "") || state.folders[0]?.directory

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
    return [...commands.filter(match), ...conversations.filter(match)]
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
                    <span class="desc">{item.detail}</span>
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
