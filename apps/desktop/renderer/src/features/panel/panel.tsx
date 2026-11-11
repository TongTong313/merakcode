import FileText from "lucide-solid/icons/file-text"
import FileDiff from "lucide-solid/icons/file-diff"
import Globe from "lucide-solid/icons/globe"
import GitBranch from "lucide-solid/icons/git-branch"
import TerminalIcon from "lucide-solid/icons/square-terminal"
import Plus from "lucide-solid/icons/plus"
import Maximize2 from "lucide-solid/icons/maximize-2"
import X from "lucide-solid/icons/x"
import { createEffect, createResource, createSignal, For, Match, on, onCleanup, Show, Switch, untrack } from "solid-js"

import { t } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { call, client } from "../../state/client"
import { listen } from "../../state/store"
import { registerDirty } from "../../state/git"
import { saveLayout, setUi, togglePanel, ui } from "../../state/ui"
import { Dialog } from "../../ui/dialog"
import { toast } from "../../ui/toast"
import { releaseBrowserState } from "../browser/state"
import { Browser } from "../browser/browser"
import { CodeView, FileTree } from "../code/code"
import { fileOwners, releaseFile } from "../code/references"
import { readDraft } from "../code/draft"
import { buffersFor } from "../code/state"
import { draftSnapshot, restoreDraftSnapshot } from "../review/compose"
import { ReviewTree } from "../review/tree"
import { ReviewFull } from "../review/full"
import { ReviewPanel } from "../review/review"
import { review, restoreReview, setReview, useReview } from "../review/state"
import { SourceControl } from "../git/source-control"
import { PlanPanel } from "../conversation/plan"
import { Terminal } from "../terminal/terminal"
import { stopTerminal } from "../terminal/resource"
import { openPanel, panels } from "./workspace"
import { TabOverview } from "./tabs"
import type { PanelTab } from "./state"

const icons = {
  file: FileText,
  review: FileDiff,
  plan: FileText,
  git: GitBranch,
  browser: Globe,
  terminal: TerminalIcon,
}

function ReviewHost(props: { tab: PanelTab; sessionID?: string; directory: string }) {
  restoreReview(props.tab.view ?? {})
  restoreDraftSnapshot(props.tab.view?.drafts)
  createEffect(
    on(
      () => props.tab.navigation,
      () =>
        setReview({
          scope: props.tab.view?.scope === "session" ? "session" : "turn",
          messageID: typeof props.tab.view?.messageID === "string" ? props.tab.view.messageID : undefined,
          focus: typeof props.tab.view?.focus === "string" ? props.tab.view.focus : undefined,
        }),
      { defer: true },
    ),
  )
  const data = useReview(
    () => props.sessionID,
    () => props.directory,
  )
  const owner = panels()
  const snapshot = () => ({ ...JSON.parse(JSON.stringify(review)), drafts: draftSnapshot() })
  createEffect(() => {
    const value = snapshot()
    untrack(() => void owner?.patch(props.tab.id, { view: value }))
  })
  const flush = () => {
    void owner?.patch(props.tab.id, { view: snapshot() })
  }
  window.addEventListener("merakcode:flush-editor", flush)
  onCleanup(() => {
    window.removeEventListener("merakcode:flush-editor", flush)
    flush()
    if (props.sessionID) {
      registerDirty(props.directory, `comments:${props.sessionID}`, 0)
      registerDirty(props.directory, `draft:${props.sessionID}`, 0)
    }
  })
  return (
    <Show
      when={ui.maximized}
      fallback={
        <div class="review-layout">
          <div class="review-column">
            <ReviewPanel sessionID={props.sessionID} directory={props.directory} data={data} />
          </div>
          <Show when={data.data()?.files.length}>
            <aside class="tree scroll" aria-label={t("review.files")}>
              <ReviewTree
                files={data.data()?.files ?? []}
                activeFile={review.focus}
                onOpen={(file) => setReview("focus", file.file)}
              />
            </aside>
          </Show>
        </div>
      }
    >
      <ReviewFull sessionID={props.sessionID} directory={props.directory} data={data} />
    </Show>
  )
}

/** Files and tools share a conversation-owned tab strip. */
export function Panel(props: { sessionID?: string; directory: string; folder: string }) {
  const controller = panels()!
  let element!: HTMLElement
  let strip!: HTMLDivElement
  const [stripElement, setStripElement] = createSignal<HTMLDivElement>()
  const active = () => panels()?.state.tabs.find((tab) => tab.id === panels()?.state.selected)
  createEffect(
    on(
      () => active()?.kind === "plan" && props.sessionID,
      (sessionID) => {
        if (sessionID)
          void call(client(props.directory).session.planView({ sessionID })).catch((error) =>
            toast({ kind: "error", title: t("error.request", { message: (error as Error).message }), error }),
          )
      },
    ),
  )
  const [overflow, setOverflow] = createSignal(false)
  const [closing, setClosing] = createSignal<PanelTab>()
  const [working, setWorking] = createSignal(false)
  const busy = () => working() || controller.state.transferring
  const needsFiles = () =>
    panels()?.state.chooser === "files" || !!panels()?.state.tabs.some((tab) => tab.kind === "file")
  const directoryOf = (tab: PanelTab) => tab.fileDirectory ?? props.directory
  const directories = () => [
    ...new Set([
      props.directory,
      ...(panels()
        ?.state.tabs.filter((tab) => tab.kind === "file")
        .map(directoryOf) ?? []),
    ]),
  ]
  const [facts, { refetch }] = createResource(
    () =>
      needsFiles() && {
        directories: directories(),
        selected: panels()?.state.selected,
        chooser: panels()?.state.chooser,
      },
    async ({ directories }) =>
      Object.fromEntries(
        await Promise.all(
          directories.map(
            async (directory) =>
              [
                directory,
                Object.fromEntries(
                  (await call(client(directory).file.status()).catch(() => [])).map((file) => [
                    file.path.replaceAll("\\", "/"),
                    { added: "A", modified: "M", deleted: "D" }[file.status],
                  ]),
                ),
              ] as const,
          ),
        ),
      ),
  )
  const status = (directory = props.directory): Record<string, string> => facts()?.[directory] ?? {}
  let refresh: ReturnType<typeof setTimeout> | undefined
  onCleanup(
    listen((directory, event) => {
      if (
        !directories().includes(directory) ||
        !needsFiles() ||
        !["file.edited", "file.watcher.updated", "vcs.changes.updated", "vcs.head.updated"].includes(event.type)
      )
        return
      clearTimeout(refresh)
      refresh = setTimeout(() => void refetch(), 100)
    }),
  )
  onCleanup(() => clearTimeout(refresh))
  const focus = () => {
    if (needsFiles()) void refetch()
  }
  window.addEventListener("focus", focus)
  onCleanup(() => window.removeEventListener("focus", focus))
  const label = (tab: PanelTab) =>
    tab.kind === "file"
      ? (tab.path?.split("/").pop() ?? "")
      : `${tab.title || t(`panel.${tab.kind}`)}${(tab.ordinal ?? 1) > 1 ? ` · ${tab.ordinal}` : ""}`
  const dirty = (tab: PanelTab) =>
    tab.kind === "file" &&
    (buffersFor(directoryOf(tab)).tabs.find((file) => file.path === tab.path)?.dirty ?? tab.view?.dirty === true)
  const hasDraft = (tab: PanelTab) => {
    if (tab.kind === "git")
      return (
        (typeof tab.view?.commit === "string" && !!tab.view.commit.trim()) ||
        (Array.isArray(tab.view?.commitAlternatives) &&
          tab.view.commitAlternatives.some((value) => typeof value === "string" && !!value.trim()))
      )
    if (tab.kind !== "review") return false
    const value = tab.id === active()?.id ? { comments: review.comments, drafts: draftSnapshot() } : tab.view
    return (
      Object.values((value?.comments ?? {}) as Record<string, unknown>).some(
        (comments) => Array.isArray(comments) && comments.length > 0,
      ) ||
      Object.values((value?.drafts ?? {}) as Record<string, { text?: unknown } | null>).some(
        (draft) => typeof draft?.text === "string" && draft.text.trim(),
      )
    )
  }
  const remove = async (tab: PanelTab, discard = false, admitted = false) => {
    const owner = controller
    if (working() || (!admitted && owner.state.transferring)) return
    const directory = props.directory
    const sessionID = props.sessionID
    const ownerID = sessionID ?? `new:${directory}`
    const fileDirectory = directoryOf(tab)
    window.dispatchEvent(new Event("merakcode:flush-editor"))
    const finish = owner.beginClose()
    setWorking(true)
    try {
      const references = tab.kind === "file" && tab.path ? await fileOwners(fileDirectory, tab.path) : []
      const lastFileReference = !references.some((value) => value !== ownerID)
      const fileDirty =
        tab.kind === "file" &&
        (buffersFor(fileDirectory).tabs.find((file) => file.path === tab.path)?.dirty ||
          owner.view(tab.id).dirty === true ||
          (lastFileReference && tab.path && !!(await readDraft(fileDirectory, tab.path))))
      if (((fileDirty && lastFileReference) || hasDraft(tab)) && !discard) return void setClosing(tab)
      if (tab.kind === "terminal") await stopTerminal(tab, directory)
      if (tab.kind === "browser" && bridge && !(await bridge.browserClose(tab.id))) return
      if (tab.kind === "browser") await releaseBrowserState(tab.id)
      if (tab.kind === "file" && tab.path) {
        const remaining = await releaseFile(fileDirectory, tab.path, ownerID)
        if (!remaining.length) await buffersFor(fileDirectory).close(tab.path)
      }
      await owner.remove(tab.id)
      if (tab.kind === "review" && sessionID) {
        registerDirty(directory, `comments:${sessionID}`, 0)
        registerDirty(directory, `draft:${sessionID}`, 0)
      }
      setClosing(undefined)
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: String(error) }), error })
    } finally {
      setWorking(false)
      finish()
    }
  }
  let endResize = () => {}
  onCleanup(() => endResize())
  const resize = (event: PointerEvent) => {
    endResize()
    const start = event.clientX
    const width = element.getBoundingClientRect().width
    const available = element.parentElement!.clientWidth
    const minimum = Math.min(360, available / 2)
    const move = (next: PointerEvent) =>
      setUi("panelWidth", Math.min(Math.max(minimum, width + start - next.clientX), available - minimum))
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      endResize = () => {}
      saveLayout()
    }
    endResize = up
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up, { once: true })
  }
  createEffect(() => {
    const current = stripElement()
    if (!current) return
    const observer = new ResizeObserver(() => setOverflow(current.scrollWidth > current.clientWidth + 1))
    observer.observe(current)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => {
    panels()?.state.tabs.length
    const id = active()?.id
    queueMicrotask(() => {
      if (!strip?.isConnected) return
      setOverflow(strip.scrollWidth > strip.clientWidth + 1)
      const tab = id && document.getElementById(`panel-tab-${id}`)?.parentElement
      if (tab) {
        if (tab.offsetLeft < strip.scrollLeft) strip.scrollLeft = tab.offsetLeft
        const right = tab.offsetLeft + tab.offsetWidth - strip.clientWidth
        if (right > strip.scrollLeft) strip.scrollLeft = right
      }
    })
  })
  const key = (event: KeyboardEvent) => {
    const tabs = panels()?.state.tabs ?? []
    const index = tabs.findIndex((tab) => tab.id === active()?.id)
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    if (!step || !tabs.length) return
    event.preventDefault()
    const target = tabs[(index + step + tabs.length) % tabs.length]!
    panels()?.activate(target.id)
    document.getElementById(`panel-tab-${target.id}`)?.focus()
  }
  return (
    <aside
      onKeyDown={(event) => {
        if (event.key === "Escape" && panels()?.state.chooser && active()) {
          event.preventDefault()
          void panels()?.update({ chooser: undefined })
        }
      }}
      ref={element}
      class="panel"
      inert={panels()?.state.transferring}
      classList={{ "panel-maximized": ui.maximized }}
      aria-label={t("panel.label")}
      style={{ width: ui.maximized ? "100%" : `${ui.panelWidth}px` }}
    >
      <Show when={!ui.maximized}>
        <div class="panel-resize" onPointerDown={resize} />
      </Show>
      <Show when={panels()?.state.error}>
        <p role="alert">
          {t("panel.persistError")}{" "}
          <button class="button secondary" onClick={() => void panels()?.update({})}>
            {t("panel.retry")}
          </button>
        </p>
      </Show>
      <Show when={working()}>
        <p role="status">{t("panel.stopping")}</p>
      </Show>
      <Show when={!ui.maximized}>
        <div class="panel-tabs">
          <div
            ref={(node) => {
              strip = node
              setStripElement(node)
            }}
            role="tablist"
            aria-label={t("panel.tabs")}
            class="row"
            onKeyDown={key}
          >
            <For each={panels()?.state.tabs ?? []}>
              {(tab) => {
                const Icon = icons[tab.kind]
                return (
                  <div class="panel-tab-wrap">
                    <button
                      id={`panel-tab-${tab.id}`}
                      role="tab"
                      class="panel-tab"
                      data-change={tab.path ? status(directoryOf(tab))[tab.path] : undefined}
                      aria-selected={!panels()?.state.chooser && active()?.id === tab.id}
                      aria-controls="panel-content"
                      tabIndex={active()?.id === tab.id ? 0 : -1}
                      onClick={() => panels()?.activate(tab.id)}
                      title={tab.path ? `${directoryOf(tab)}/${tab.path}` : label(tab)}
                    >
                      <Icon class="icon icon-sm" />
                      <span class="ellipsis">{label(tab)}</span>
                      <Show when={tab.path && status(directoryOf(tab))[tab.path]}>
                        {(change) => <span class="mark">{change()}</span>}
                      </Show>
                      <Show when={dirty(tab)}>
                        <span class="dirty" aria-label={t("code.unsaved")}>
                          ●
                        </span>
                      </Show>
                    </button>
                    <button
                      class="icon-button sm"
                      aria-label={t("panel.closeTab", { name: label(tab) })}
                      disabled={working()}
                      onClick={() => void remove(tab)}
                    >
                      <X class="icon icon-xs" />
                    </button>
                  </div>
                )
              }}
            </For>
          </div>
          <Show when={overflow()}>
            <TabOverview
              tabs={panels()?.state.tabs ?? []}
              active={active()?.id}
              busy={working()}
              label={label}
              activate={(id) => panels()?.activate(id)}
              close={(tab) => void remove(tab)}
            />
          </Show>
          <button
            class="icon-button"
            aria-label={t("panel.newTab")}
            onClick={() => void panels()?.update({ chooser: "new" })}
          >
            <Plus class="icon icon-sm" />
          </button>
          <Show when={active()?.kind === "review" && !panels()?.state.chooser}>
            <button class="icon-button" aria-label={t("panel.maximize")} onClick={() => setUi("maximized", true)}>
              <Maximize2 class="icon icon-sm" />
            </button>
          </Show>
          <button class="icon-button" aria-label={t("panel.close")} onClick={togglePanel}>
            <X class="icon icon-sm" />
          </button>
        </div>
      </Show>
      <div
        class="panel-body"
        id="panel-content"
        role="tabpanel"
        aria-labelledby={active() ? `panel-tab-${active()!.id}` : undefined}
      >
        <Show
          when={panels()?.state.chooser || !active()}
          fallback={
            <Show when={active()} keyed>
              {(tab) => (
                <Switch>
                  <Match when={tab.kind === "file"}>
                    <CodeView
                      planSessionID={tab.planSessionID}
                      tabID={tab.id}
                      directory={directoryOf(tab)}
                      path={tab.path}
                      status={status(directoryOf(tab))}
                    />
                  </Match>
                  <Match when={tab.kind === "review"}>
                    <ReviewHost tab={tab} sessionID={props.sessionID} directory={props.directory} />
                  </Match>
                  <Match when={tab.kind === "plan"}>
                    <Show when={props.sessionID} fallback={<p class="muted">{t("plan.empty")}</p>}>
                      {(id) => <PlanPanel sessionID={id()} directory={props.directory} />}
                    </Show>
                  </Match>
                  <Match when={tab.kind === "git"}>
                    <SourceControl
                      instanceID={tab.id}
                      sessionID={props.sessionID}
                      directory={props.directory}
                      folder={props.folder}
                    />
                  </Match>
                  <Match when={tab.kind === "browser"}>
                    <Browser tab={tab} sessionID={props.sessionID} directory={props.directory} />
                  </Match>
                  <Match when={tab.kind === "terminal"}>
                    <Terminal directory={props.directory} tab={tab} sessionID={props.sessionID} />
                  </Match>
                </Switch>
              )}
            </Show>
          }
        >
          <Show
            when={panels()?.state.chooser === "files"}
            fallback={
              <div class="panel-chooser">
                <p>{t("panel.choose")}</p>
                <For each={controller.available()}>
                  {(kind) => {
                    const Icon = icons[kind]
                    return (
                      <button
                        class="button secondary"
                        data-panel-kind={kind}
                        onClick={() =>
                          kind === "file" ? void panels()?.update({ chooser: "files" }) : void openPanel({ kind })
                        }
                      >
                        <Icon class="icon" />
                        {kind === "file" ? t("panel.openFile") : t(`panel.${kind}`)}
                      </button>
                    )
                  }}
                </For>
              </div>
            }
          >
            <div class="code-pane">
              <div class="empty-state subtle editor">{t("code.empty")}</div>
              <FileTree directory={props.directory} status={status()} />
            </div>
          </Show>
        </Show>
      </div>
      <Dialog
        open={!!closing()}
        title={t(closing()?.kind === "file" ? "code.closeDirtyTitle" : "panel.closeDraftTitle")}
        description={
          closing()?.kind === "file"
            ? t("code.closeDirtyDetail", { path: closing()?.path ?? "" })
            : t("panel.closeDraftDetail")
        }
        onOpenChange={(open) => !open && !busy() && setClosing(undefined)}
        footer={
          <>
            <button class="button secondary" disabled={busy()} onClick={() => setClosing(undefined)}>
              {t("common.cancel")}
            </button>
            <button
              class="button secondary"
              disabled={busy()}
              onClick={() => closing() && void remove(closing()!, true)}
            >
              {t("code.discard")}
            </button>
            <Show when={closing()?.kind === "file"}>
              <button
                class="button primary"
                disabled={busy()}
                onClick={async () => {
                  const tab = closing()
                  const owner = controller
                  if (!tab || busy()) return
                  const finish = owner.beginClose()
                  setWorking(true)
                  try {
                    const buffer = buffersFor(directoryOf(tab))
                    if (tab.path) await buffer.open(tab.path, tab.planSessionID)
                    await buffer.save(false, tab.path)
                    setWorking(false)
                    if (!dirty(tab)) await remove(tab, false, true)
                  } catch (error) {
                    toast({ kind: "error", title: t("error.request", { message: String(error) }), error })
                  } finally {
                    setWorking(false)
                    finish()
                  }
                }}
              >
                {t("panel.saveClose")}
              </button>
            </Show>
          </>
        }
      />
    </aside>
  )
}
