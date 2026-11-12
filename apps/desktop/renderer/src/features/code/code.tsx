import { diffLines } from "diff"
import type { EngineFileNode as FileNode } from "@merakcode/sdk"
import type * as Monaco from "monaco-editor"
import ChevronDown from "lucide-solid/icons/chevron-down"
import ChevronRight from "lucide-solid/icons/chevron-right"
import FileText from "lucide-solid/icons/file-text"
import Folder from "lucide-solid/icons/folder"
import { untrack, createEffect, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { t } from "../../i18n"
import { sameDir } from "../../lib/route"
import { client } from "../../state/client"
import { listen } from "../../state/store"
import { toast } from "../../ui/toast"
import { openPanel, panels } from "../panel/workspace"
import { buffersFor, loadMonaco } from "./state"

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
      client()
        .then((connection) => connection.file.list({ directory, path }))
        .then((list) => (list ?? []).filter((node) => !node.ignored)),
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
  const [local, setLocal] = createSignal(false)
  const open = () => panels()?.state.expanded.includes(props.node.path) ?? local()
  const setOpen = (value: boolean) => {
    const state = panels()
    if (!state) return void setLocal(value)
    void state.update({
      expanded: value
        ? [...state.state.expanded, props.node.path]
        : state.state.expanded.filter((path) => path !== props.node.path),
    })
  }
  const dir = () => props.node.type === "directory"
  const mark = () => props.status[props.node.path.replaceAll("\\", "/")]
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
 * File panel: Monaco editor with an optional workspace tree on the right. Ctrl+S saves and reports a
 * conflict if the file changed elsewhere.
 */
export function CodeView(props: {
  tabID: string
  directory: string
  path?: string
  planSessionID?: string
  status: Record<string, string>
}) {
  let host!: HTMLDivElement
  const owner = panels()
  const id = props.tabID
  const buffer = buffersFor(props.directory)
  if (props.path && id) buffer.retain(props.path, id)
  const tabs = () => buffer.tabs
  const active = () => props.path
  const [monaco, setMonaco] = createSignal<typeof Monaco>()
  let editor: Monaco.editor.IStandaloneCodeEditor | undefined
  const settings = () => owner?.view(id ?? "") ?? {}
  // The editor loads lazily; opening a file waits for it if it is not ready yet
  const loading = loadMonaco()
  let disposed = false
  let stopRemember = () => {}

  onCleanup(
    listen(
      (directory, event) =>
        sameDir(directory, props.directory) &&
        (event.type === "file.changed" || event.type === "repo.changed") &&
        void buffer.reload().catch(() => {}),
    ),
  )
  const focus = () => void buffer.reload().catch(() => {})
  window.addEventListener("focus", focus)
  onCleanup(() => window.removeEventListener("focus", focus))

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
    editor.addCommand(loaded.KeyMod.CtrlCmd | loaded.KeyCode.KeyS, () => void buffer.save(false, props.path))
    let viewTimer: ReturnType<typeof setTimeout> | undefined
    const remember = () => {
      clearTimeout(viewTimer)
      if (id && editor)
        void owner?.patchView(id, {
          editor: editor.saveViewState(),
          dirty: buffer.tabs.find((tab) => tab.path === props.path)?.dirty ?? false,
        })
    }
    const schedule = () => {
      clearTimeout(viewTimer)
      viewTimer = setTimeout(remember, 100)
    }
    const cursor = editor.onDidChangeCursorPosition(schedule)
    const scroll = editor.onDidScrollChange(schedule)
    window.addEventListener("merakcode:flush-editor", remember)
    window.addEventListener("pagehide", remember)
    stopRemember = () => {
      clearTimeout(viewTimer)
      cursor.dispose()
      scroll.dispose()
      window.removeEventListener("merakcode:flush-editor", remember)
      window.removeEventListener("pagehide", remember)
    }
    setMonaco(loaded)
  })
  onCleanup(() => {
    disposed = true
    stopRemember()
    if (id && editor) void owner?.patchView(id, { editor: editor.saveViewState() })
    editor?.dispose()
    if (props.path && id)
      void buffer.suspend(props.path, id).catch(() => toast({ kind: "error", title: t("panel.persistError") }))
  })

  createEffect(() => {
    const tab = tabs().find((item) => item.path === props.path)
    if (id && tab) untrack(() => void owner?.patchView(id, { dirty: tab.dirty }))
  })
  const open = (path: string) => buffer.open(path, props.planSessionID)

  createEffect(
    on(
      () => props.path,
      (path) => {
        if (path) void open(path)
      },
    ),
  )

  createEffect(() => {
    const loaded = monaco()
    const tab = tabs().find((item) => item.path === active())
    if (!loaded || !editor) return
    if (!tab?.model) {
      editor.setModel(null)
      return
    }
    const changed = editor.getModel() !== tab.model
    editor.setModel(tab.model)
    editor.updateOptions({ readOnly: !!tab.missing })
    const saved = untrack(settings).editor
    if (saved && changed) editor.restoreViewState(saved as Monaco.editor.ICodeEditorViewState)
    const decorations = editor.createDecorationsCollection()
    const mark = () => {
      let line = 1
      const result: Monaco.editor.IModelDeltaDecoration[] = []
      for (const part of diffLines(tab.original ?? tab.saved, tab.model!.getValue())) {
        const count = part.count ?? 0
        if (part.added || part.removed)
          result.push({
            range: new loaded.Range(Math.max(1, line), 1, Math.max(1, line + (part.added ? count - 1 : 0)), 1),
            options: { isWholeLine: true, linesDecorationsClassName: part.added ? "file-added" : "file-deleted" },
          })
        if (!part.removed) line += count
      }
      decorations.set(result)
    }
    mark()
    const listener = tab.model.onDidChangeContent(mark)
    onCleanup(() => {
      listener.dispose()
      decorations.clear()
    })
    if (changed) editor.focus()
  })

  return (
    <div class="code-pane">
      <div class="editor">
        <div class="file-toolbar row">
          <span class="mono ellipsis" title={props.path}>
            {props.path?.replace(/\//g, " › ")}
          </span>
        </div>
        <Show when={props.path && buffer.errors[props.path]}>
          <p role="alert">
            {t("panel.fileLoadError")} {props.path && buffer.errors[props.path]}
          </p>
          <button class="button secondary" onClick={() => props.path && void open(props.path)}>
            {t("panel.retry")}
          </button>
        </Show>
        <Show when={tabs().find((tab) => tab.path === active())?.preview}>
          {(src) => <img class="file-preview" src={src()} alt={props.path?.split("/").pop()} />}
        </Show>
        <Show
          when={
            tabs().find((tab) => tab.path === active())?.binary &&
            !tabs().find((tab) => tab.path === active())?.preview &&
            !tabs().find((tab) => tab.path === active())?.missing
          }
        >
          <div class="empty-state subtle">{t("code.binary")}</div>
        </Show>
        <Show when={tabs().find((tab) => tab.path === active())?.conflict}>
          <p class="branch-notice" role="status">
            {t("code.branchConflict")}
          </p>
        </Show>
        <Show when={tabs().find((tab) => tab.path === active())?.alternatives?.length}>
          <select
            aria-label={t("code.recoveredDrafts")}
            value=""
            onChange={(event) => {
              buffer.selectDraft(active()!, Number(event.currentTarget.value))
              event.currentTarget.value = ""
            }}
          >
            <option value="" disabled>
              {t("code.recoveredDrafts")}
            </option>
            <For each={tabs().find((tab) => tab.path === active())?.alternatives}>
              {(draft, index) => <option value={index()}>{draft.content.slice(0, 100)}</option>}
            </For>
          </select>
        </Show>
        <Show when={tabs().find((tab) => tab.path === active())?.missing}>
          <p class="branch-notice" role="status">
            {t("code.missing")}
          </p>
        </Show>
        <Show when={props.planSessionID}>
          <p class="branch-notice" role="status">
            {t("plan.editHint")}
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
      <FileTree directory={props.directory} active={props.path} status={props.status} />
    </div>
  )
}

export function FileTree(props: { directory: string; active?: string; status?: Record<string, string> }) {
  return (
    <div class="tree scroll" role="tree" aria-label={t("code.files")}>
      <Level
        directory={props.directory}
        path=""
        depth={0}
        status={props.status ?? {}}
        active={props.active}
        onOpen={(path) =>
          void openPanel({ kind: "file", fileDirectory: props.directory, path }).catch((error: unknown) =>
            toast({ kind: "error", title: t("error.request", { message: String(error) }), error }),
          )
        }
      />
    </div>
  )
}
