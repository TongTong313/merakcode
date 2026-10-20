import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import type { BorderSides, BoxRenderable, DiffRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import path from "path"
import { LANGUAGE_EXTENSIONS } from "@merakcode/util/language"
import { useSDK } from "../../context/sdk"
import { useRoute, useRouteData } from "../../context/route"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { useLocale } from "../../context/locale"
import { useSync } from "../../context/sync"
import { useKV } from "../../context/kv"
import { DialogSelect } from "../../ui/dialog-select"
import { useCommandDialog } from "../../component/dialog-command"
import { DiffViewerFileTree } from "./file-tree"
import { DiffViewerHelpDialog } from "./help"
import { Panel, PanelGroup, Separator } from "./ui"
import { snapshotToVcsDiff } from "./patch"
import { resolveDiffViewerKey } from "./diff-keyboard"
import { collectRenderedHunks, pickRelativeHunk } from "./diff-hunk"
import { resolveFileTreeActivation } from "./diff-file-tree-action"
import {
  allExpandedFileTreeDirectories,
  buildFileTree,
  fileTreeFileSelection,
  flattenFileTree,
  moveFileTreeSelection,
  movePatchFileIndex,
  orderedPatchFileIndexes,
  showDiffViewerFileTree,
  singlePatchFileIndex,
  stableIndexList,
  toggleFileTreeDirectory,
  type FileTreeRow,
} from "./file-tree-utils"

const MIN_SPLIT_WIDTH = 100
const FILE_TREE_WIDTH = 32
const PLAIN_TEXT_FILETYPE = "none"
const KV_SHOW_FILE_TREE = "diff_viewer_show_file_tree"
const KV_SINGLE_PATCH = "diff_viewer_single_patch"
const KV_VIEW = "diff_viewer_view"
/** Above this many files, single-file mode turns on automatically to avoid mounting too many <diff> nodes. */
const LARGE_DIFF_FILE_COUNT = 50
/** The last-turn source is not wired up yet, so it is hidden from the source switcher. */
const LAST_TURN_SOURCE_ENABLED = false

type DiffMode = "git" | "branch" | "last-turn"
type DiffViewerFocus = "patches" | "files"
type DiffView = "split" | "unified"
type SelectedHunk = { fileIndex: number; hunkIndex: number; scrollTop: number }

type DiffFile = {
  file: string
  patch?: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
  truncated?: boolean
}

function filetype(input?: string) {
  if (!input) return "none"
  const language = LANGUAGE_EXTENSIONS[path.extname(input)]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function storedView(value: unknown): DiffView | undefined {
  if (value === "split" || value === "unified") return value
}

function diffSourceLabel(mode: DiffMode | undefined, locale: ReturnType<typeof useLocale>) {
  if (mode === "last-turn") return locale.t("diff.source.lastTurn")
  if (mode === "branch") return locale.t("diff.source.branch")
  return locale.t("diff.source.workingTree")
}

export function DiffViewer() {
  const route = useRoute()
  const params = useRouteData("diff")
  const sdk = useSDK()
  const dialog = useDialog()
  const command = useCommandDialog()
  const locale = useLocale()
  const sync = useSync()
  const kv = useKV()
  const dimensions = useTerminalDimensions()
  const themeState = useTheme()
  const theme = () => themeState.theme

  const mode = (): DiffMode => {
    const raw = params.mode ?? "git"
    if (raw === "last-turn" && !LAST_TURN_SOURCE_ENABLED) return "git"
    return raw
  }

  const diffInput = createMemo(() => ({
    mode: mode(),
    sessionID: params.sessionID,
    messageID: params.messageID,
  }))

  const [diff] = createResource(diffInput, async (input) => {
    if (input.mode === "last-turn") {
      const sessionID = input.sessionID
      if (!sessionID) return []
      const result = await sdk.client.session.diff({ sessionID, messageID: input.messageID }, { throwOnError: true })
      return (result.data ?? []).map(snapshotToVcsDiff) as DiffFile[]
    }
    const result = await sdk.client.vcs.diff({ mode: input.mode }, { throwOnError: true })
    return (result.data ?? []) as DiffFile[]
  })

  const files = createMemo((): DiffFile[] => diff() ?? [])
  const truncatedFileCount = createMemo(() => files().filter((file) => file.truncated).length)
  const [focus, setFocus] = createSignal<DiffViewerFocus>("patches")
  const [fileTreeEnabled, setFileTreeEnabled] = createSignal(kv.get(KV_SHOW_FILE_TREE, true) !== false)
  const showFileTree = createMemo(() => showDiffViewerFileTree(fileTreeEnabled(), files().length))
  const patchPaneWidth = createMemo(() => dimensions().width - (showFileTree() ? 33 : 0) - 4)
  const patchLeftBorder = createMemo<BorderSides[]>(() => (showFileTree() ? ["left"] : []))
  const splitAvailable = createMemo(() => patchPaneWidth() >= MIN_SPLIT_WIDTH)
  const defaultView = createMemo(() => {
    if (sync.data.config.tui?.diff_style === "stacked") return "unified"
    return splitAvailable() ? "split" : "unified"
  })
  const [viewOverride, setViewOverride] = createSignal<DiffView | undefined>(storedView(kv.get(KV_VIEW)))
  const view = createMemo(() => (splitAvailable() ? (viewOverride() ?? defaultView()) : "unified"))
  const [singlePatch, setSinglePatch] = createSignal(kv.get(KV_SINGLE_PATCH, false) === true)
  const fileTree = createMemo(() => buildFileTree(files()))
  const [expandedFileNodes, setExpandedFileNodes] = createSignal<ReadonlySet<number>>(new Set())
  const [highlightedFileNode, setHighlightedFileNode] = createSignal<number | undefined>()
  const [lastHighlightedFileNode, setLastHighlightedFileNode] = createSignal<number | undefined>()
  const [activePatchFileIndex, setActivePatchFileIndex] = createSignal<number | undefined>()
  const [selectedFileIndex, setSelectedFileIndex] = createSignal<number | undefined>()
  const [reviewedFileNames, setReviewedFileNames] = createSignal<ReadonlySet<string>>(new Set())
  const [selectedHunk, setSelectedHunk] = createSignal<SelectedHunk | undefined>()
  const [patchFillerHeight, setPatchFillerHeight] = createSignal(0)
  const renderer = useRenderer()
  const fileRows = createMemo(() => flattenFileTree(fileTree(), expandedFileNodes()))
  const patchFileIndexes = createMemo(() => orderedPatchFileIndexes(flattenFileTree(fileTree())))

  let scroll: ScrollBoxRenderable | undefined
  let measureFillerFrame: number | undefined
  let cachedPatchFileIndexes: number[] = []
  let cachedVisiblePatchFileIndexes: number[] = []
  const patchNodeByFileIndex = new Map<number, BoxRenderable>()
  const diffNodeByFileIndex = new Map<number, DiffRenderable>()

  const clearPatchNodeMaps = () => {
    patchNodeByFileIndex.clear()
    diffNodeByFileIndex.clear()
    cachedPatchFileIndexes = []
    cachedVisiblePatchFileIndexes = []
  }

  onCleanup(() => {
    dialog.clear()
    if (measureFillerFrame !== undefined) cancelAnimationFrame(measureFillerFrame)
  })

  createEffect(() => {
    diffInput()
    clearPatchNodeMaps()
    setExpandedFileNodes(allExpandedFileTreeDirectories(fileTree()))
    setHighlightedFileNode(undefined)
    setLastHighlightedFileNode(undefined)
    setActivePatchFileIndex(undefined)
    setSelectedFileIndex(undefined)
    setSelectedHunk(undefined)
    setReviewedFileNames(new Set<string>())
  })

  const setHighlighted = (node: number | undefined) => {
    setHighlightedFileNode(node)
    if (node !== undefined) setLastHighlightedFileNode(node)
  }

  const ensureHighlightedFileNode = () => {
    const highlighted = highlightedFileNode()
    if (highlighted !== undefined && fileRows().some((row) => row.id === highlighted)) return
    const lastHighlighted = lastHighlightedFileNode()
    const next =
      lastHighlighted !== undefined && fileRows().some((row) => row.id === lastHighlighted)
        ? lastHighlighted
        : fileRows().find((row) => row.fileIndex !== undefined)?.id
    setHighlightedFileNode(next)
  }

  const scrollPatchNodeToTop = (patchNode: BoxRenderable) => {
    requestAnimationFrame(() => {
      if (!scroll) return
      const scrollDelta = patchNode.y - scroll.viewport.y
      scroll.scrollBy(scrollDelta + (scroll.scrollTop + scrollDelta === 0 ? 0 : 1))
    })
  }

  const revealFileTreeFile = (fileIndex: number) => {
    const selection = fileTreeFileSelection(fileTree(), fileIndex)
    if (!selection) return
    setExpandedFileNodes((expanded) => {
      let changed = false
      const next = new Set(expanded)
      selection.expandedNodes.forEach((node) => {
        if (next.has(node)) return
        next.add(node)
        changed = true
      })
      return changed ? next : expanded
    })
    if (highlightedFileNode() !== selection.highlightedNode) setHighlighted(selection.highlightedNode)
  }

  const selectPatchFile = (fileIndex: number) => {
    if (selectedFileIndex() === fileIndex && activePatchFileIndex() === fileIndex) {
      revealFileTreeFile(fileIndex)
      return
    }
    revealFileTreeFile(fileIndex)
    setActivePatchFileIndex(fileIndex)
    setSelectedFileIndex(fileIndex)
  }

  const scrollToFileIndex = (fileIndex: number | undefined) => {
    if (fileIndex === undefined) return
    if (selectedFileIndex() === fileIndex) return
    setSelectedHunk(undefined)
    selectPatchFile(fileIndex)
    const patchNode = patchNodeByFileIndex.get(fileIndex)
    if (patchNode) scrollPatchNodeToTop(patchNode)
  }

  const currentPatchFileIndex = () => {
    if (!scroll) return undefined
    const viewportContentY = scroll.scrollTop + 1
    const entries = patchFileIndexes()
      .map((fileIndex) => ({
        fileIndex,
        node: patchNodeByFileIndex.get(fileIndex),
      }))
      .filter((entry): entry is { fileIndex: number; node: BoxRenderable } =>
        Boolean(entry.node && !entry.node.isDestroyed),
      )
      .map((entry) => ({
        ...entry,
        contentY: scroll!.scrollTop + entry.node.y - scroll!.viewport.y,
      }))
      .sort((left, right) => left.contentY - right.contentY)
    return entries.findLast((entry) => entry.contentY <= viewportContentY)?.fileIndex ?? entries[0]?.fileIndex
  }

  const firstPatchFileIndex = () => fileRows().find((row) => row.fileIndex !== undefined)?.fileIndex

  const stablePatchFileIndexes = createMemo(() => {
    const next = patchFileIndexes()
    cachedPatchFileIndexes = stableIndexList(cachedPatchFileIndexes, next) as number[]
    return cachedPatchFileIndexes
  })

  // Not based on currentPatchFileIndex: it depends on scroll layout, so any click-triggered measure makes it flicker
  // and rebuild the <diff>.
  const visiblePatchFileIndexes = createMemo(() => {
    const next = !singlePatch()
      ? stablePatchFileIndexes()
      : (() => {
          const fileIndex = singlePatchFileIndex(
            selectedFileIndex(),
            activePatchFileIndex(),
            undefined,
            firstPatchFileIndex(),
          )
          return fileIndex === undefined ? [] : [fileIndex]
        })()
    cachedVisiblePatchFileIndexes = stableIndexList(cachedVisiblePatchFileIndexes, next) as number[]
    return cachedVisiblePatchFileIndexes
  })

  const visiblePatchFiles = createMemo(() =>
    visiblePatchFileIndexes().flatMap((fileIndex) => {
      const file = files()[fileIndex]
      return file ? [{ file, fileIndex }] : []
    }),
  )

  const measurePatchFiller = () => {
    if (measureFillerFrame !== undefined) cancelAnimationFrame(measureFillerFrame)
    measureFillerFrame = requestAnimationFrame(() => {
      measureFillerFrame = undefined
      if (!scroll) return
      const entries = visiblePatchFiles()
        .map((entry) => patchNodeByFileIndex.get(entry.fileIndex))
        .filter((node): node is BoxRenderable => Boolean(node && !node.isDestroyed))
      if (entries.length === 0) {
        setPatchFillerHeight(0)
        return
      }
      const contentHeight = Math.max(
        ...entries.map((node) => scroll!.scrollTop + node.y - scroll!.viewport.y + node.height),
      )
      const next = Math.max(0, scroll.viewport.height - contentHeight)
      if (next !== patchFillerHeight()) setPatchFillerHeight(next)
    })
  }

  const registerPatchNode = (fileIndex: number, element: BoxRenderable) => {
    if (element.isDestroyed) return
    patchNodeByFileIndex.set(fileIndex, element)
    measurePatchFiller()
  }

  createEffect(() => {
    dimensions()
    singlePatch()
    files().length
    measurePatchFiller()
  })

  // OpenTUI's Solid binding does not always rebuild on diff.view prop updates, so sync it manually after a resize.
  createEffect(() => {
    const next = view()
    for (const node of diffNodeByFileIndex.values()) {
      if (node.isDestroyed) continue
      if (node.view !== next) node.view = next
    }
  })

  const scrollSinglePatchToTop = () => {
    requestAnimationFrame(() => {
      scroll?.scrollTo(0)
      requestAnimationFrame(() => scroll?.scrollTo(0))
    })
  }

  // After switching source or reloading, default to single-file mode for large diffs (unless the user pressed 1 to
  // expand all).
  createEffect(
    on(
      () => [diffInput(), files().length, diff.loading] as const,
      ([, count, loading]) => {
        if (loading || count === 0) return
        if (count <= LARGE_DIFF_FILE_COUNT) return
        clearPatchNodeMaps()
        setSinglePatch(true)
        kv.set(KV_SINGLE_PATCH, true)
        const fileIndex = firstPatchFileIndex()
        if (fileIndex !== undefined) selectPatchFile(fileIndex)
        scrollSinglePatchToTop()
      },
    ),
  )

  const close = () => {
    dialog.clear()
    route.navigate(params.returnRoute ?? { type: "home" })
  }

  const jumpRelativePatchFile = (offset: number) => {
    setSelectedHunk(undefined)
    const next = movePatchFileIndex(patchFileIndexes(), selectedFileIndex() ?? activePatchFileIndex(), offset)
    if (singlePatch()) {
      if (next === undefined) return
      selectPatchFile(next)
      scrollSinglePatchToTop()
      return
    }
    scrollToFileIndex(next)
  }

  const jumpRelativeHunk = (offset: -1 | 1) => {
    const patchScroll = scroll
    if (!patchScroll) return

    const gather = () =>
      collectRenderedHunks(
        visiblePatchFiles().flatMap((entry) => {
          const patch = entry.file.patch
          if (!patch) return []
          const node = diffNodeByFileIndex.get(entry.fileIndex)
          if (!node || node.isDestroyed) return []
          return [
            {
              fileIndex: entry.fileIndex,
              baseContentY: patchScroll.scrollTop + node.y - patchScroll.viewport.y,
              hunkRows: node.getHunkRowOffsets(),
              patch,
            },
          ]
        }),
      )

    const apply = (hunks: ReturnType<typeof gather>) => {
      const selected = selectedHunk()
      const next = pickRelativeHunk(hunks, patchScroll.scrollTop, selected, offset)
      if (!next) {
        // [ on the first hunk scrolls back to the top of the diff.
        if (offset === -1 && selected) {
          const at = hunks.findIndex(
            (hunk) => hunk.fileIndex === selected.fileIndex && hunk.hunkIndex === selected.hunkIndex,
          )
          if (at === 0) {
            patchScroll.scrollTo(0)
            setSelectedHunk(undefined)
          }
        }
        return
      }
      selectPatchFile(next.fileIndex)
      patchScroll.scrollTo(next.contentY)
      setSelectedHunk({ fileIndex: next.fileIndex, hunkIndex: next.hunkIndex, scrollTop: next.contentY })
    }

    const hunks = gather()
    if (hunks.length > 0) {
      apply(hunks)
      return
    }
    // getHunkRowOffsets may not be ready right after switching files; retry on the next frame.
    requestAnimationFrame(() => {
      const retry = gather()
      if (retry.length > 0) apply(retry)
    })
  }

  const toggleSelectedFileReviewed = () => {
    const fileIndex =
      focus() === "files"
        ? fileRows().find((row) => row.id === highlightedFileNode())?.fileIndex
        : (selectedFileIndex() ?? activePatchFileIndex() ?? currentPatchFileIndex())
    const file = fileIndex === undefined ? undefined : files()[fileIndex]?.file
    if (!file) return
    setReviewedFileNames((reviewed) => {
      const next = new Set(reviewed)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  const moveFileSelection = (offset: number) =>
    setHighlighted(moveFileTreeSelection(fileRows(), highlightedFileNode(), offset))

  const switchSourceOptions = createMemo(() => {
    const vcs = sync.data.vcs
    return [
      {
        title: locale.t("diff.source.workingTree"),
        value: "git" as const,
        description: locale.t("diff.source.workingTreeDesc"),
      },
      ...(vcs?.branch && vcs.default_branch && vcs.branch !== vcs.default_branch
        ? [
            {
              title: locale.t("diff.source.branch"),
              value: "branch" as const,
              description: locale.t("diff.source.branchDesc"),
            },
          ]
        : []),
      ...(LAST_TURN_SOURCE_ENABLED
        ? [
            {
              title: locale.t("diff.source.lastTurn"),
              value: "last-turn" as const,
              description: locale.t("diff.source.lastTurnDesc"),
            },
          ]
        : []),
    ]
  })

  const openSwitchDiffDialog = () => {
    dialog.replace(() => (
      <DialogSelect
        title={locale.t("diff.switchSource")}
        skipFilter={true}
        current={mode()}
        options={switchSourceOptions().map((option) => ({
          ...option,
          onSelect(d) {
            d.clear()
            route.navigate({
              type: "diff",
              mode: option.value,
              sessionID: params.sessionID,
              messageID: params.messageID,
              returnRoute: params.returnRoute,
            })
          },
        }))}
      />
    ))
  }

  const openHelpDialog = () => {
    dialog.replace(() => <DiffViewerHelpDialog />)
    dialog.setSize("large")
  }

  const toggleSinglePatch = () => {
    setSelectedHunk(undefined)
    if (!singlePatch()) {
      const fileIndex =
        selectedFileIndex() ?? activePatchFileIndex() ?? currentPatchFileIndex() ?? firstPatchFileIndex()
      if (fileIndex !== undefined) selectPatchFile(fileIndex)
      setSinglePatch(true)
      kv.set(KV_SINGLE_PATCH, true)
      scrollSinglePatchToTop()
      return
    }
    const fileIndex =
      visiblePatchFiles()[0]?.fileIndex ??
      singlePatchFileIndex(selectedFileIndex(), activePatchFileIndex(), currentPatchFileIndex(), firstPatchFileIndex())
    if (fileIndex !== undefined) selectPatchFile(fileIndex)
    setSinglePatch(false)
    kv.set(KV_SINGLE_PATCH, false)
  }

  const activateFileTreeRow = (row: FileTreeRow | undefined) => {
    const activation = resolveFileTreeActivation(row, selectedFileIndex())
    if (activation.type === "noop") return
    if (activation.type === "scroll-to-file") {
      scrollToFileIndex(activation.fileIndex)
      return
    }
    setExpandedFileNodes((expanded) => toggleFileTreeDirectory(fileTree(), expanded, activation.nodeId))
  }

  const clickFileTreeRow = (row: FileTreeRow) => {
    setFocus("files")
    if (highlightedFileNode() !== row.id) setHighlighted(row.id)
    activateFileTreeRow(row)
  }

  const handleKeyRef: { current: (evt: KeyEvent) => void } = { current: () => {} }

  const handleKey = (evt: KeyEvent) => {
    const action = resolveDiffViewerKey({
      name: evt.name,
      ctrl: evt.ctrl,
      defaultPrevented: evt.defaultPrevented,
      dialogOpen: dialog.stack.length > 0,
      focus: focus(),
      showFileTree: showFileTree(),
      splitAvailable: splitAvailable(),
    })
    if (action.type === "ignore") return

    evt.preventDefault()
    evt.stopPropagation()

    switch (action.action) {
      case "close-dialog":
        dialog.clear()
        return
      case "close-viewer":
        close()
        return
      case "open-help":
        openHelpDialog()
        return
      case "toggle-focus":
        setFocus((current) => {
          if (current === "files") return "patches"
          ensureHighlightedFileNode()
          return "files"
        })
        return
      case "open-switch-source":
        openSwitchDiffDialog()
        return
      case "toggle-view": {
        setSelectedHunk(undefined)
        const next = view() === "split" ? "unified" : "split"
        setViewOverride(next)
        kv.set(KV_VIEW, next)
        return
      }
      case "toggle-file-tree": {
        const next = !fileTreeEnabled()
        if (!next) setFocus("patches")
        setFileTreeEnabled(next)
        kv.set(KV_SHOW_FILE_TREE, next)
        return
      }
      case "toggle-single-patch":
        toggleSinglePatch()
        return
      case "toggle-reviewed":
        toggleSelectedFileReviewed()
        return
      case "next-file":
        jumpRelativePatchFile(1)
        return
      case "prev-file":
        jumpRelativePatchFile(-1)
        return
      case "next-hunk":
        jumpRelativeHunk(1)
        return
      case "prev-hunk":
        jumpRelativeHunk(-1)
        return
      case "move-file-selection":
        moveFileSelection(action.offset)
        return
      case "activate-file-tree-row":
        activateFileTreeRow(fileRows().find((item) => item.id === highlightedFileNode()))
        return
      case "scroll-patch":
        setSelectedHunk(undefined)
        scroll?.scrollBy(action.delta)
        return
      case "scroll-patch-page":
        setSelectedHunk(undefined)
        if (scroll) scroll.scrollBy(action.delta * scroll.height)
        return
    }
  }

  handleKeyRef.current = handleKey

  // Takes precedence over other global handlers; global command keybinds are paused in the diff view to avoid
  // conflicts with n/p/t/s etc.
  onMount(() => {
    dialog.clear()
    command.keybinds(false)
    const listener = (evt: KeyEvent) => handleKeyRef.current(evt)
    renderer.keyInput.prependListener("keypress", listener)
    onCleanup(() => {
      renderer.keyInput.off("keypress", listener)
      command.keybinds(true)
    })
  })

  return (
    <box position="absolute" zIndex={2500} left={0} top={0} width={dimensions().width} height={dimensions().height}>
      <PanelGroup axis="y" width="100%" height="100%">
        <Panel border="none" flexShrink={0} padding={0} paddingLeft={1}>
          <text fg={theme().text}>{locale.t("diff.title")} </text>
          <text fg={theme().textMuted}>{diffSourceLabel(mode(), locale)}</text>
          <Show when={showFileTree()}>
            <text fg={focus() === "files" ? theme().primary : theme().textMuted}>
              {focus() === "files" ? locale.t("diff.focusFiles") : locale.t("diff.focusPatches")}
            </text>
          </Show>
          <box flexGrow={1} />
          <text fg={theme().textMuted}>
            {files().length} {files().length === 1 ? locale.t("diff.fileOne") : locale.t("diff.fileMany")}
          </text>
          <Show when={truncatedFileCount() > 0}>
            <text fg={theme().warning}>{locale.t("diff.truncatedSummary", { count: truncatedFileCount() })}</text>
          </Show>
        </Panel>

        <box flexGrow={1} minHeight={0}>
          <Switch>
            <Match when={diff.loading}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().textMuted}>{locale.t("diff.loading")}</text>
              </box>
            </Match>
            <Match when={!diff.loading && files().length === 0}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().textMuted}>{locale.t("diff.empty")}</text>
              </box>
            </Match>
            <Match when={!diff.loading && diff.error}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().error}>{locale.t("diff.error")}</text>
              </box>
            </Match>
            <Match when={!diff.loading}>
              <PanelGroup axis="x">
                <Show when={showFileTree()}>
                  <DiffViewerFileTree
                    files={files()}
                    loading={diff.loading}
                    error={diff.error}
                    theme={theme()}
                    focused={focus() === "files"}
                    width={FILE_TREE_WIDTH}
                    highlightedNode={highlightedFileNode()}
                    selectedFileIndex={selectedFileIndex()}
                    reviewedFileNames={reviewedFileNames()}
                    expandedNodes={expandedFileNodes()}
                    onRowClick={clickFileTreeRow}
                  />
                </Show>

                <Panel flexGrow={1} minHeight={0} border="none">
                  <Separator axis="x" start={showFileTree() ? "edge-out" : undefined} />
                  <scrollbox
                    ref={(element: ScrollBoxRenderable) => (scroll = element)}
                    flexGrow={1}
                    minHeight={0}
                    verticalScrollbarOptions={{ visible: false }}
                    horizontalScrollbarOptions={{ visible: false }}
                  >
                    <For each={visiblePatchFileIndexes()}>
                      {(fileIndex, index) => {
                        const file = () => files()[fileIndex]
                        const reviewed = () => {
                          const path = file()?.file
                          return path !== undefined && reviewedFileNames().has(path)
                        }
                        return (
                          <box ref={(element: BoxRenderable) => registerPatchNode(fileIndex, element)}>
                            {index() !== 0 ? <Separator axis="x" start={showFileTree() ? "edge" : undefined} /> : null}
                            <box
                              flexDirection="row"
                              gap={1}
                              flexShrink={0}
                              paddingLeft={1}
                              paddingRight={1}
                              border={patchLeftBorder()}
                              borderColor={theme().border}
                            >
                              <text fg={reviewed() ? theme().textMuted : theme().text}>{file()?.file}</text>
                              <box flexGrow={1} />
                              <text fg={reviewed() ? theme().textMuted : theme().diffAdded}>
                                +{file()?.additions ?? 0}
                              </text>
                              <text fg={reviewed() ? theme().textMuted : theme().diffRemoved}>
                                -{file()?.deletions ?? 0}
                              </text>
                            </box>
                            <Separator axis="x" start={showFileTree() ? "edge" : undefined} />
                            <Show when={file()?.truncated}>
                              <box border={patchLeftBorder()} borderColor={theme().border} paddingLeft={1}>
                                <text fg={theme().warning}>{locale.t("diff.patchTruncated")}</text>
                              </box>
                            </Show>
                            <Show
                              when={
                                !file()?.truncated &&
                                typeof file()?.patch === "string" &&
                                (file()?.patch?.length ?? 0) > 0
                              }
                            >
                              <box border={patchLeftBorder()} borderColor={theme().border}>
                                <diff
                                  ref={(element: DiffRenderable) => {
                                    if (element.isDestroyed) return
                                    diffNodeByFileIndex.set(fileIndex, element)
                                  }}
                                  diff={file()!.patch!}
                                  view={view()}
                                  filetype={reviewed() ? PLAIN_TEXT_FILETYPE : filetype(file()?.file)}
                                  syntaxStyle={themeState.syntax()}
                                  showLineNumbers={true}
                                  width="100%"
                                  wrapMode="char"
                                  fg={reviewed() ? theme().textMuted : theme().text}
                                  addedBg={reviewed() ? theme().backgroundElement : theme().diffAddedBg}
                                  removedBg={reviewed() ? theme().backgroundElement : theme().diffRemovedBg}
                                  addedSignColor={reviewed() ? theme().textMuted : theme().diffHighlightAdded}
                                  removedSignColor={reviewed() ? theme().textMuted : theme().diffHighlightRemoved}
                                  lineNumberFg={theme().diffLineNumber}
                                  addedLineNumberBg={
                                    reviewed() ? theme().backgroundElement : theme().diffAddedLineNumberBg
                                  }
                                  removedLineNumberBg={
                                    reviewed() ? theme().backgroundElement : theme().diffRemovedLineNumberBg
                                  }
                                />
                              </box>
                            </Show>
                            <Show when={!file()?.truncated && !file()?.patch}>
                              <text fg={theme().textMuted}>{locale.t("diff.noPatch")}</text>
                            </Show>
                          </box>
                        )
                      }}
                    </For>
                    <Show when={patchFillerHeight() > 0}>
                      <box height={patchFillerHeight()} border={patchLeftBorder()} borderColor={theme().border} />
                    </Show>
                  </scrollbox>
                  <Separator axis="x" start={showFileTree() ? "edge-in" : undefined} />
                </Panel>
              </PanelGroup>
            </Match>
          </Switch>
        </box>

        <Panel flexShrink={0} gap={2} paddingLeft={1} paddingRight={1} border="none">
          <text fg={theme().text}>
            h <span style={{ fg: theme().textMuted }}>{locale.t("diff.helpShort")}</span>
          </text>
          <Show when={showFileTree()}>
            <text fg={theme().text}>
              tab <span style={{ fg: theme().textMuted }}>{locale.t("diff.focusShort")}</span>
            </text>
          </Show>
          <text fg={theme().text}>
            m <span style={{ fg: theme().textMuted }}>{locale.t("diff.markReviewedShort")}</span>
          </text>
          <text fg={theme().text}>
            [ / ] <span style={{ fg: theme().textMuted }}>{locale.t("diff.hunkShort")}</span>
          </text>
          <text fg={theme().text}>
            n/p <span style={{ fg: theme().textMuted }}>{locale.t("diff.nextPrevFile")}</span>
          </text>
          <box flexGrow={1} minWidth={0} />
          <text fg={theme().text}>
            1{" "}
            <span style={{ fg: singlePatch() ? theme().primary : theme().textMuted }}>
              {singlePatch() ? locale.t("diff.singlePatchOn") : locale.t("diff.singlePatchOff")}
            </span>
          </text>
        </Panel>
      </PanelGroup>
    </box>
  )
}
