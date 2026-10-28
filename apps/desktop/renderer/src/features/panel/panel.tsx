import Code from "lucide-solid/icons/code-xml"
import FileDiff from "lucide-solid/icons/file-diff"
import Globe from "lucide-solid/icons/globe"
import Maximize2 from "lucide-solid/icons/maximize-2"
import X from "lucide-solid/icons/x"
import GitBranch from "lucide-solid/icons/git-branch"
import { Match, Show, Switch } from "solid-js"
import { t } from "../../i18n"
import { saveLayout, setUi, showTab, togglePanel, ui, type Tab } from "../../state/ui"
import { Browser } from "../browser/browser"
import { CodeView } from "../code/code"
import { ReviewPanel } from "../review/review"
import { progress, useReview } from "../review/state"
import { SourceControl } from "../git/source-control"

/** Side panel with review, code and browser tabs; drag the left edge to resize */
export function Panel(props: { sessionID?: string; directory: string; folder: string }) {
  let panel!: HTMLElement
  const data = useReview(
    () => props.sessionID,
    () => props.directory,
    () => ui.tab === "review",
  )
  const count = () => progress(data.data()).total
  const tabs: { id: Tab; label: () => string; icon: typeof Code }[] = [
    { id: "review", label: () => t("panel.review"), icon: FileDiff },
    { id: "git", label: () => t("panel.git"), icon: GitBranch },
    { id: "code", label: () => t("panel.code"), icon: Code },
    { id: "browser", label: () => t("panel.browser"), icon: Globe },
  ]

  const resize = (event: PointerEvent) => {
    const start = event.clientX
    const width = panel.getBoundingClientRect().width
    const available = panel.parentElement!.clientWidth
    const minimum = Math.min(360, available / 2)
    const maximum = available - minimum
    const move = (next: PointerEvent) =>
      setUi("panelWidth", Math.min(Math.max(minimum, width + start - next.clientX), maximum))
    const up = () => {
      window.removeEventListener("pointermove", move)
      saveLayout()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up, { once: true })
  }

  const key = (event: KeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.id === ui.tab)
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = tabs[(index + step + tabs.length) % tabs.length]!
    showTab(next.id)
    document.getElementById(`panel-tab-${next.id}`)?.focus()
  }

  return (
    <aside ref={panel} class="panel" aria-label={t("panel.label")} style={{ width: `${ui.panelWidth}px` }}>
      <div class="panel-resize" onPointerDown={resize} />
      <div class="panel-tabs">
        <div role="tablist" aria-label={t("panel.tabs")} class="row" onKeyDown={key}>
          {tabs.map((tab) => (
            <button
              id={`panel-tab-${tab.id}`}
              role="tab"
              class="panel-tab"
              aria-selected={ui.tab === tab.id}
              aria-controls={`panel-${tab.id}`}
              tabIndex={ui.tab === tab.id ? 0 : -1}
              onClick={() => showTab(tab.id)}
            >
              <tab.icon class="icon icon-sm" />
              {tab.label()}
              <Show when={tab.id === "review" && count()}>
                <span class="count">{count()}</span>
              </Show>
            </button>
          ))}
        </div>
        <Show when={ui.tab === "review"}>
          <button class="icon-button" aria-label={t("panel.maximize")} onClick={() => setUi("maximized", true)}>
            <Maximize2 class="icon icon-sm" />
          </button>
        </Show>
        <button class="icon-button" aria-label={t("panel.close")} onClick={togglePanel}>
          <X class="icon icon-sm" />
        </button>
      </div>
      <div class="panel-body" role="tabpanel" id={`panel-${ui.tab}`} aria-labelledby={`panel-tab-${ui.tab}`}>
        <Switch>
          <Match when={ui.tab === "review"}>
            <ReviewPanel sessionID={props.sessionID} directory={props.directory} data={data} />
          </Match>
          <Match when={ui.tab === "git"}>
            <SourceControl sessionID={props.sessionID} directory={props.directory} folder={props.folder} />
          </Match>
          <Match when={ui.tab === "code"}>
            <CodeView directory={props.directory} />
          </Match>
          <Match when={ui.tab === "browser"}>
            <Browser sessionID={props.sessionID} directory={props.directory} />
          </Match>
        </Switch>
      </div>
    </aside>
  )
}
