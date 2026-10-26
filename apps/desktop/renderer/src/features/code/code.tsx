import type { FileNode } from "@merakcode/sdk/client"
import type * as Monaco from "monaco-editor"
import ChevronDown from "lucide-solid/icons/chevron-down"
import ChevronRight from "lucide-solid/icons/chevron-right"
import FileText from "lucide-solid/icons/file-text"
import Folder from "lucide-solid/icons/folder"
import X from "lucide-solid/icons/x"
import { createEffect, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { listen } from "../../state/store"
import { ui } from "../../state/ui"
import { Confirm } from "../../ui/dialog"
import { buffersFor, loadMonaco } from "./state"

const marks: Record<string, string> = { added: "A", modified: "M", deleted: "D" }

/** One level of the file tree; a directory is read when expanded */
function Level(props: {
  directory: string
  path: string
  depth: number
  status: Record<string, string>
  active?: string
  onOpen: (path: string) => void
}) {
  const [nodes] = createResource(
    () => [props.directory, props.path] as const,
    ([directory, path]) =>
      call(client(directory).file.list({ path })).then((list) => list.filter((node) => !node.ignored)),
  )
  return (
    <For each={nodes()}>
      {(node) => (
        <Node
          node={node}
          directory={props.directory}
          depth={props.depth}
          status={props.status}
          active={props.active}
          onOpen={props.onOpen}
        />
      )}
    </For>
  )
}

function Node(props: {
  node: FileNode
  directory: string
  depth: number
  status: Record<string, string>
  active?: string
  onOpen: (path: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  const dir = () => props.node.type === "directory"
  const mark = () => props.status[props.node.path]
  return (
    <>
      <div
        role="treeitem"
        class="tree-row"
        classList={{ on: props.active === props.node.path }}
        aria-expanded={dir() ? open() : undefined}
        aria-selected={props.active === props.node.path}
        aria-level={props.depth + 1}
        tabIndex={-1}
        style={{ "padding-left": `${6 + props.depth * 14}px` }}
        onClick={() => (dir() ? setOpen(!open()) : props.onOpen(props.node.path))}
        onKeyDown={(event) => event.key === "Enter" && (dir() ? setOpen(!open()) : props.onOpen(props.node.path))}
      >
        <Show when={dir()} fallback={<FileText class="icon icon-sm subtle" />}>
          {open() ? <ChevronDown class="icon icon-sm subtle" /> : <ChevronRight class="icon icon-sm subtle" />}
          <Folder class="icon icon-sm subtle" />
        </Show>
        <span class="ellipsis">{props.node.name}</span>
        <Show when={mark()}>
          <span class={`mark ${mark()!.toLowerCase()}`} aria-hidden="true">
            {mark()}
          </span>
        </Show>
      </div>
      <Show when={dir() && open()}>
        <Level
          directory={props.directory}
          path={props.node.path}
          depth={props.depth + 1}
          status={props.status}
          active={props.active}
          onOpen={props.onOpen}
        />
      </Show>
    </>
  )
}

/**
 * Code tab: file tree with git changes marked on the left, Monaco editor on the right. Ctrl+S saves and reports a
 * conflict if the file changed elsewhere.
 */
export function CodeView(props: { directory: string }) {
  let host!: HTMLDivElement
  const buffer = () => buffersFor(props.directory)
  const tabs = () => buffer().tabs
  const active = () => buffer().active()
  const setActive = (path: string | undefined) => buffer().setActive(path)
  const [closing, setClosing] = createSignal<string>()
  const [status, setStatus] = createSignal<Record<string, string>>({})
  const [monaco, setMonaco] = createSignal<typeof Monaco>()
  let editor: Monaco.editor.IStandaloneCodeEditor | undefined
  // The editor loads lazily; opening a file waits for it if it is not ready yet
  const loading = loadMonaco()
  let disposed = false

  const loadStatus = () => {
    const directory = props.directory
    return call(client(directory).file.status())
      .then((list) => {
        if (directory === props.directory)
          setStatus(Object.fromEntries(list.map((item) => [item.path, marks[item.status] ?? "M"])))
      })
      .catch(() => {})
  }
  createEffect(
    on(
      () => props.directory,
      () => void loadStatus(),
    ),
  )
  onCleanup(
    listen(
      (directory, event) => directory === props.directory && event.type === "file.watcher.updated" && void loadStatus(),
    ),
  )

  onMount(async () => {
    const { monaco: loaded } = await loading
    if (disposed) return
    editor = loaded.editor.create(host, {
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
      fontSize: 12,
      lineHeight: 20,
      fontLigatures: false,
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      // Do not highlight other occurrences of the word at the cursor: a freshly opened file lights up everywhere
      occurrencesHighlight: "off",
      tabSize: 2,
    })
    editor.addCommand(loaded.KeyMod.CtrlCmd | loaded.KeyCode.KeyS, () => void buffer().save())
    setMonaco(loaded)
  })
  onCleanup(() => {
    disposed = true
    editor?.dispose()
  })

  const open = (path: string) => buffer().open(path)

  // File requested from the review or a file-edit card
  createEffect(
    on(
      () => ui.openFile?.at,
      () => {
        const request = ui.openFile
        if (request) void open(request.path)
      },
    ),
  )

  createEffect(
    on([active, monaco], ([path]) => {
      const tab = tabs().find((item) => item.path === path)
      editor?.setModel(tab?.model ?? null)
      if (tab?.model) editor?.focus()
    }),
  )

  const close = (path: string) => {
    if (tabs().find((item) => item.path === path)?.dirty) return void setClosing(path)
    buffer().close(path)
  }

  return (
    <div class="code-pane">
      <div class="tree scroll" role="tree" aria-label={t("code.files")}>
        <Level
          directory={props.directory}
          path=""
          depth={0}
          status={status()}
          active={active()}
          onOpen={(path) => void open(path)}
        />
      </div>
      <div class="editor">
        <div class="editor-tabs" role="tablist">
          <For each={tabs()}>
            {(tab) => (
              <div
                class="editor-tab"
                classList={{ on: tab.path === active() }}
                role="tab"
                aria-selected={tab.path === active()}
                onClick={() => setActive(tab.path)}
              >
                <span class="ellipsis" title={tab.path}>
                  {tab.path.split(/[\\/]/).pop()}
                </span>
                <Show when={tab.dirty}>
                  <span class="dirty" title={t("code.unsaved")} />
                </Show>
                <button
                  class="icon-button sm"
                  aria-label={t("code.closeTab", { name: tab.path })}
                  onClick={(event) => (event.stopPropagation(), close(tab.path))}
                >
                  <X class="icon icon-xs" />
                </button>
              </div>
            )}
          </For>
        </div>
        <Show when={tabs().find((tab) => tab.path === active())?.binary}>
          <div class="empty-state subtle">{t("code.binary")}</div>
        </Show>
        <Show when={tabs().find((tab) => tab.path === active())?.conflict}>
          <p class="branch-notice" role="status">
            {t("code.branchConflict")}
          </p>
        </Show>
        <Show when={!active()}>
          <div class="empty-state subtle">{t("code.empty")}</div>
        </Show>
        <div
          class="editor-host"
          ref={host}
          classList={{ hidden: !active() || !!tabs().find((tab) => tab.path === active())?.binary }}
        />
      </div>
      <Confirm
        open={!!closing()}
        title={t("code.closeDirtyTitle")}
        description={t("code.closeDirtyDetail", { path: closing() ?? "" })}
        confirm={t("code.discard")}
        cancel={t("code.keepEditing")}
        danger
        onResult={(discard) => {
          if (discard && closing()) buffer().close(closing()!)
          setClosing(undefined)
        }}
      />
    </div>
  )
}
