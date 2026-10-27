import PanelRight from "lucide-solid/icons/panel-right"
import SquareTerminal from "lucide-solid/icons/square-terminal"
import { Show, type JSX } from "solid-js"
import { t } from "../../i18n"
import { mac } from "../../lib/bridge"
import { setUi, togglePanel, ui } from "../../state/ui"
import { Tip } from "../../ui/tooltip"
import { Panel } from "../panel/panel"
import { ReviewFull } from "../review/full"
import { Terminal } from "../terminal/terminal"

const mod = mac ? "⌘" : "Ctrl"

/**
 * Frame of the main area: top bar (title, actions, terminal and side panel toggles), content, side panel and bottom
 * terminal. Shared by the new-conversation and conversation pages, so code, browser, terminal and the maximized
 * review work before a conversation starts.
 */
export function Frame(props: {
  title: JSX.Element
  actions?: JSX.Element
  sessionID?: string
  /** Directory for the panel and terminal (the worktree directory for a worktree conversation) */
  directory: string
  /** Project directory in the sidebar */
  folder: string
  children: JSX.Element
}) {
  return (
    <Show when={!ui.maximized} fallback={<ReviewFull sessionID={props.sessionID} directory={props.directory} />}>
      <main class="main">
        <div class="topbar drag">
          {props.title}
          <span class="spacer" />
          <div class="no-drag row">
            {props.actions}
            <Tip label={t("topbar.terminal")} keys={`${mod} J`}>
              <button
                class="icon-button"
                aria-label={t("topbar.terminal")}
                aria-pressed={ui.terminal}
                onClick={() => setUi("terminal", !ui.terminal)}
              >
                <SquareTerminal class="icon" />
              </button>
            </Tip>
            <Tip label={t("topbar.panel")} keys={`${mod} B`}>
              <button class="icon-button" aria-label={t("topbar.panel")} aria-pressed={ui.panel} onClick={togglePanel}>
                <PanelRight class="icon" />
              </button>
            </Tip>
          </div>
        </div>
        <div class="workspace">
          <section class="thread">{props.children}</section>
          <Show when={ui.panel}>
            <Panel sessionID={props.sessionID} directory={props.directory} folder={props.folder} />
          </Show>
        </div>
        <Show when={ui.terminal}>
          <Terminal directory={props.directory} />
        </Show>
      </main>
    </Show>
  )
}
