import PanelRight from "lucide-solid/icons/panel-right"
import SquareTerminal from "lucide-solid/icons/square-terminal"
import { createEffect, createSignal, on, Show, type JSX } from "solid-js"
import { t } from "../../i18n"
import { mac } from "../../lib/bridge"
import { setUi, togglePanel, ui } from "../../state/ui"
import { Tip } from "../../ui/tooltip"
import { Panel } from "../panel/panel"
import { openPanel, panels, selectPanels } from "../panel/workspace"
import { fromError, type MerakCodeError, summary } from "../../state/error"
import { directoryRecovery, recoverDirectory } from "../code/identity"

const mod = mac ? "⌘" : "Ctrl"

/**
 * Frame of the main area: top bar, conversation and editor panels.
 * Shared by the new-conversation and conversation pages, so code, browser, terminal and the maximized
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
  const [failed, setFailed] = createSignal<MerakCodeError>()
  const [recovering, setRecovering] = createSignal(false)
  const select = () => {
    setFailed(undefined)
    void selectPanels({ directory: props.directory, sessionID: props.sessionID }).catch((error: unknown) =>
      setFailed(fromError(error)),
    )
  }
  createEffect(
    on(
      () => [props.directory, props.sessionID] as const,
      () => {
        setUi("maximized", false)
        select()
      },
    ),
  )
  createEffect(() => {
    const state = panels()
    if (!state) return
    setUi({ panel: state.state.visible, panelWidth: state.state.width })
    if (!state.state.visible || state.state.tabs.find((tab) => tab.id === state.state.selected)?.kind !== "review")
      setUi("maximized", false)
  })
  return (
    <main class="main">
      <Show when={!ui.maximized}>
        <div class="topbar drag">
          {props.title}
          <span class="spacer" />
          <div class="no-drag row">
            {props.actions}
            <Tip label={t("topbar.terminal")} keys={`${mod} J`}>
              <button
                class="icon-button"
                aria-label={t("topbar.terminal")}
                disabled={!panels() || panels()?.state.transferring}
                onClick={() => {
                  setUi("panel", true)
                  void openPanel({ kind: "terminal" }, true)
                }}
              >
                <SquareTerminal class="icon" />
              </button>
            </Tip>
            <Tip label={t("topbar.panel")} keys={`${mod} B`}>
              <button
                class="icon-button"
                aria-label={t("topbar.panel")}
                aria-pressed={ui.panel}
                disabled={!panels() || panels()?.state.transferring}
                onClick={togglePanel}
              >
                <PanelRight class="icon" />
              </button>
            </Tip>
          </div>
        </div>
      </Show>
      <div class="workspace">
        <Show when={failed()}>
          <div role="alert" class="empty-state">
            <p>{failed()?.message}</p>
            <p class="mono">{summary(failed())}</p>
            <Show when={directoryRecovery(failed())}>
              {(choice) => (
                <>
                  <p>{t("code.directoryRecoveryChoice", { directory: choice().directory, actual: choice().actual })}</p>
                  <button
                    class="button secondary"
                    disabled={recovering()}
                    onClick={async () => {
                      setRecovering(true)
                      try {
                        await recoverDirectory(choice())
                        select()
                      } catch (error) {
                        setFailed(fromError(error))
                      } finally {
                        setRecovering(false)
                      }
                    }}
                  >
                    {t("code.recoverDirectory")}
                  </button>
                </>
              )}
            </Show>
            <button class="button secondary" disabled={recovering()} onClick={select}>
              {t("panel.retry")}
            </button>
          </div>
        </Show>
        <Show when={!ui.maximized}>
          <section class="thread">{props.children}</section>
        </Show>
        <Show when={ui.panel && panels()} keyed>
          {(_state) => {
            const directory = props.directory
            const sessionID = props.sessionID
            const folder = props.folder
            return <Panel sessionID={sessionID} directory={directory} folder={folder} />
          }}
        </Show>
      </div>
    </main>
  )
}
