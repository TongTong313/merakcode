import type { BoxRenderable, TextareaRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { pathToFileURL } from "url"
import fuzzysort from "fuzzysort"
import { firstBy } from "remeda"
import { createMemo, createResource, createEffect, onMount, onCleanup, Index, Show, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useTheme, selectedForeground } from "../../context/theme"
import { useCommandDialog } from "../dialog-command"
import { Locale } from "@merakcode/util/locale"
import { useLocale } from "../../context/locale"
import type { PromptInfo } from "./history"
import { useFrecency } from "./frecency"
import { useOverlay } from "../../context/overlay"
import stringWidth from "string-width"

function removeLineRange(input: string) {
  const hashIndex = input.lastIndexOf("#")
  return hashIndex !== -1 ? input.substring(0, hashIndex) : input
}

function extractLineRange(input: string) {
  const hashIndex = input.lastIndexOf("#")
  if (hashIndex === -1) {
    return { baseQuery: input }
  }

  const baseName = input.substring(0, hashIndex)
  const linePart = input.substring(hashIndex + 1)
  const lineMatch = linePart.match(/^(\d+)(?:-(\d*))?$/)

  if (!lineMatch) {
    return { baseQuery: baseName }
  }

  const startLine = Number(lineMatch[1])
  const endLine = lineMatch[2] && startLine < Number(lineMatch[2]) ? Number(lineMatch[2]) : undefined

  return {
    lineRange: {
      baseName,
      startLine,
      endLine,
    },
    baseQuery: baseName,
  }
}

export type AutocompleteRef = {
  onInput: (value: string) => void
  onKeyDown: (e: KeyEvent) => void
  visible: false | "@" | "/"
}

export type AutocompleteOption = {
  display: string
  value?: string
  aliases?: string[]
  disabled?: boolean
  description?: string
  // Text used only for fuzzy search: when `description` is truncated for layout (e.g. single-line skills), this keeps
  // the full text so keywords still match. Falls back to `description`.
  searchText?: string
  isDirectory?: boolean
  onSelect?: () => void
  path?: string
  group?: "agent" | "file" | "resource"
  isHeader?: boolean
}

export function Autocomplete(props: {
  value: string
  sessionID?: string
  setPrompt: (input: (prompt: PromptInfo) => void) => void
  setExtmark: (partIndex: number, extmarkId: number) => void
  anchor: () => BoxRenderable
  input: () => TextareaRenderable
  ref: (ref: AutocompleteRef) => void
  fileStyleId: number
  agentStyleId: number
  promptPartTypeId: () => number
}) {
  const sdk = useSDK()
  const sync = useSync()
  const command = useCommandDialog()
  const { theme } = useTheme()
  const frecency = useFrecency()
  const overlay = useOverlay()
  const locale = useLocale()

  const [store, setStore] = createStore({
    index: 0,
    selected: 0,
    visible: false as AutocompleteRef["visible"],
    input: "keyboard" as "keyboard" | "mouse",
  })

  const [positionTick, setPositionTick] = createSignal(0)

  createEffect(() => {
    if (store.visible) {
      let lastPos = { x: 0, y: 0, width: 0 }
      const interval = setInterval(() => {
        const anchor = props.anchor()
        if (anchor.x !== lastPos.x || anchor.y !== lastPos.y || anchor.width !== lastPos.width) {
          lastPos = { x: anchor.x, y: anchor.y, width: anchor.width }
          setPositionTick((t) => t + 1)
        }
      }, 50)

      onCleanup(() => clearInterval(interval))
    }
  })

  const position = createMemo(() => {
    if (!store.visible) return { x: 0, y: 0, width: 0 }
    positionTick()
    const anchor = props.anchor()
    // Overlay content renders at the session's main box (anchor → prompt container → session main box).
    const overlayParent = anchor.parent?.parent
    const parentX = overlayParent?.x ?? 0
    const parentY = overlayParent?.y ?? 0

    return {
      x: anchor.x - parentX,
      y: anchor.y - parentY,
      width: anchor.width,
    }
  })

  const filter = createMemo(() => {
    if (!store.visible) return
    // Track props.value to make memo reactive to text changes
    props.value // <- there surely is a better way to do this, like making .input() reactive

    return props.input().getTextRange(store.index + 1, props.input().cursorOffset)
  })

  // filter() reads reactive props.value plus non-reactive cursor/text state.
  // On keypress those can be briefly out of sync, so filter() may return an empty/partial string.
  // Copy it into search in an effect because effects run after reactive updates have been rendered and painted
  // so the input has settled and all consumers read the same stable value.
  const [search, setSearch] = createSignal("")
  createEffect(() => {
    const next = filter()
    setSearch(next ? next : "")
  })

  // When the filter changes due to how TUI works, the mousemove might still be triggered
  // via a synthetic event as the layout moves underneath the cursor. This is a workaround to make sure the input mode remains keyboard so
  // that the mouseover event doesn't trigger when filtering.
  createEffect(() => {
    filter()
    setStore("input", "keyboard")
  })

  function insertPart(text: string, part: PromptInfo["parts"][number]) {
    const input = props.input()
    const currentCursorOffset = input.cursorOffset

    const charAfterCursor = props.value.at(currentCursorOffset)
    const needsSpace = charAfterCursor !== " "
    const append = "@" + text + (needsSpace ? " " : "")

    input.cursorOffset = store.index
    const startCursor = input.logicalCursor
    input.cursorOffset = currentCursorOffset
    const endCursor = input.logicalCursor

    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    input.insertText(append)

    const virtualText = "@" + text
    const extmarkStart = store.index
    const extmarkEnd = extmarkStart + stringWidth(virtualText)

    const styleId = part.type === "file" ? props.fileStyleId : part.type === "agent" ? props.agentStyleId : undefined

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId,
      typeId: props.promptPartTypeId(),
    })

    props.setPrompt((draft) => {
      if (part.type === "file") {
        const existingIndex = draft.parts.findIndex((p) => p.type === "file" && "url" in p && p.url === part.url)
        if (existingIndex !== -1) {
          const existing = draft.parts[existingIndex]
          if (
            part.source?.text &&
            existing &&
            "source" in existing &&
            existing.source &&
            "text" in existing.source &&
            existing.source.text
          ) {
            existing.source.text.start = extmarkStart
            existing.source.text.end = extmarkEnd
            existing.source.text.value = virtualText
          }
          return
        }
      }

      if (part.type === "file" && part.source?.text) {
        part.source.text.start = extmarkStart
        part.source.text.end = extmarkEnd
        part.source.text.value = virtualText
      } else if (part.type === "agent" && part.source) {
        part.source.start = extmarkStart
        part.source.end = extmarkEnd
        part.source.value = virtualText
      }
      const partIndex = draft.parts.length
      draft.parts.push(part)
      props.setExtmark(partIndex, extmarkId)
    })

    if (part.type === "file" && part.source && part.source.type === "file") {
      frecency.updateFrecency(part.source.path)
    }
  }

  const [files] = createResource(
    () => ({ query: search(), visible: store.visible }),
    async ({ query, visible }) => {
      if (!visible || visible === "/") return []

      const { lineRange, baseQuery } = extractLineRange(query ?? "")

      // Get files from SDK
      // Request the maximum of 200; the server default of 10 would cut the list short.
      const result = await sdk.client.find.files({
        query: baseQuery,
        limit: 200,
      })

      const options: AutocompleteOption[] = []

      // Add file options
      if (!result.error && result.data) {
        // Without a query the unfiltered initial listing shows directories first. With a query, fuzzysort ranks by
        // match quality, so type is ignored here to avoid ranking directories above better-matching files.
        const preferDirectory = !baseQuery
        const sortedFiles = result.data.sort((a, b) => {
          if (preferDirectory) {
            const aIsDir = a.endsWith("/")
            const bIsDir = b.endsWith("/")
            if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
          }
          const aScore = frecency.getFrecency(a)
          const bScore = frecency.getFrecency(b)
          if (aScore !== bScore) return bScore - aScore
          const aDepth = a.split("/").length
          const bDepth = b.split("/").length
          if (aDepth !== bDepth) return aDepth - bDepth
          return a.localeCompare(b)
        })

        const width = props.anchor().width - 4
        options.push(
          ...sortedFiles.map((item): AutocompleteOption => {
            const fullPath = `${process.cwd()}/${item}`
            const urlObj = pathToFileURL(fullPath)
            let filename = item
            if (lineRange && !item.endsWith("/")) {
              filename = `${item}#${lineRange.startLine}${lineRange.endLine ? `-${lineRange.endLine}` : ""}`
              urlObj.searchParams.set("start", String(lineRange.startLine))
              if (lineRange.endLine !== undefined) {
                urlObj.searchParams.set("end", String(lineRange.endLine))
              }
            }
            const url = urlObj.href

            const isDir = item.endsWith("/")
            return {
              display: Locale.truncateMiddle(filename, width),
              value: filename,
              isDirectory: isDir,
              group: "file",
              path: item,
              onSelect: () => {
                insertPart(filename, {
                  type: "file",
                  mime: "text/plain",
                  filename,
                  url,
                  source: {
                    type: "file",
                    text: {
                      start: 0,
                      end: 0,
                      value: "",
                    },
                    path: item,
                  },
                })
              },
            }
          }),
        )
      }

      return options
    },
    {
      initialValue: [],
    },
  )

  const mcpResources = createMemo(() => {
    if (!store.visible || store.visible === "/") return []

    const options: AutocompleteOption[] = []
    const width = props.anchor().width - 4

    for (const res of Object.values(sync.data.mcp_resource)) {
      const text = `${res.name} (${res.uri})`
      options.push({
        display: Locale.truncateMiddle(text, width),
        value: text,
        group: "resource",
        description: res.description,
        onSelect: () => {
          insertPart(res.name, {
            type: "file",
            mime: res.mimeType ?? "text/plain",
            filename: res.name,
            url: res.uri,
            source: {
              type: "resource",
              text: {
                start: 0,
                end: 0,
                value: "",
              },
              clientName: res.client,
              uri: res.uri,
            },
          })
        },
      })
    }

    return options
  })

  const agents = createMemo(() => {
    const agents = sync.data.agent
    return agents
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent): AutocompleteOption => ({
        display: "@" + agent.name,
        group: "agent",
        onSelect: () => {
          insertPart(agent.name, {
            type: "agent",
            name: agent.id,
            source: {
              start: 0,
              end: 0,
              value: "",
            },
          })
        },
      }))
  })

  const commands = createMemo((): AutocompleteOption[] => {
    const results: AutocompleteOption[] = [...command.slashes()]

    for (const serverCommand of sync.data.command) {
      if (serverCommand.source === "skill") continue
      const label = serverCommand.source === "mcp" ? ":mcp" : ""

      // Built-in commands get localized descriptions.
      let description = serverCommand.description
      if (serverCommand.name === "init") {
        description = locale.t("command.init")
      } else if (serverCommand.name === "review") {
        description = locale.t("command.review")
      } else if (serverCommand.name === "mc-app") {
        description = locale.t("command.mcApp")
      }

      results.push({
        display: "/" + serverCommand.name + label,
        description: description,
        onSelect: () => {
          const newText = "/" + serverCommand.name + " "
          const cursor = props.input().logicalCursor
          props.input().deleteRange(0, 0, cursor.row, cursor.col)
          props.input().insertText(newText)
          props.input().cursorOffset = stringWidth(newText)
        },
      })
    }

    results.sort((a, b) => a.display.localeCompare(b.display))

    const max = firstBy(results, [(x) => x.display.length, "desc"])?.display.length
    if (!max) return results
    return results.map((item) => ({
      ...item,
      display: item.display.padEnd(max + 2),
    }))
  })

  const groupHeaders = createMemo(() => ({
    agent: locale.t("autocomplete.group.agent"),
    file: locale.t("autocomplete.group.file"),
    resource: locale.t("autocomplete.group.resource"),
  }))

  function buildGroupedOptions(
    agentsList: AutocompleteOption[],
    filesList: AutocompleteOption[],
    resourcesList: AutocompleteOption[],
    searchValue: string,
    isLoading: boolean,
  ): AutocompleteOption[] {
    const headers = groupHeaders()
    const rawGroups: { items: AutocompleteOption[]; header: string; groupId: "agent" | "file" | "resource" }[] = [
      { items: agentsList, header: headers.agent, groupId: "agent" },
      { items: filesList, header: headers.file, groupId: "file" },
      { items: resourcesList, header: headers.resource, groupId: "resource" },
    ]

    if (!searchValue) {
      const result: AutocompleteOption[] = []
      for (const g of rawGroups) {
        if (g.items.length === 0) continue
        result.push({ display: g.header, group: g.groupId, isHeader: true })
        result.push(...g.items)
      }
      return result
    }

    const cleanedSearch = removeLineRange(searchValue)
    const SLOTS: Record<string, number> = { agent: 5, file: 4, resource: 3 }
    const result: AutocompleteOption[] = []

    for (const group of rawGroups) {
      if (group.items.length === 0) continue

      if (isLoading && group.groupId === "file") {
        continue
      }

      const scored = fuzzysort.go(cleanedSearch, group.items, {
        limit: 0,
        threshold: 0,
        keys: [
          (obj) => removeLineRange((obj.value ?? obj.display).trimEnd()),
          (obj) => obj.searchText ?? obj.description ?? "",
          (obj) => obj.aliases?.join(" ") ?? "",
        ],
        scoreFn: (objResults) => {
          const displayResult = objResults[0]
          let score = objResults.score
          if (displayResult && displayResult.target.startsWith(store.visible + searchValue)) {
            score *= 2
          }
          const frecencyScore = objResults.obj.path ? frecency.getFrecency(objResults.obj.path) : 0
          return score * (1 + frecencyScore)
        },
      })

      const matched = scored.map((r) => r.obj)
      if (matched.length === 0) continue

      result.push({ display: group.header, group: group.groupId, isHeader: true })
      result.push(...matched.slice(0, SLOTS[group.groupId]))
    }

    return result
  }

  const options = createMemo((): AutocompleteOption[] => {
    const filesValue = files()
    const agentsValue = agents()
    const commandsValue = commands()

    if (store.visible === "/") {
      const s = search()
      if (!s) return [...commandsValue]
      const result = fuzzysort.go(s, commandsValue, {
        keys: [
          (obj) => (obj.value ?? obj.display).trimEnd(),
          (obj) => obj.searchText ?? obj.description ?? "",
          (obj) => obj.aliases?.join(" ") ?? "",
        ],
        limit: 10,
        threshold: 0,
        scoreFn: (objResults) => {
          const displayResult = objResults[0]
          let score = objResults.score
          if (displayResult && displayResult.target.startsWith("/" + s)) {
            score *= 2
          }
          return score
        },
      })
      return result.map((arr) => arr.obj)
    }

    const searchValue = search()
    return buildGroupedOptions(agentsValue, filesValue ?? [], mcpResources(), searchValue, files.loading)
  })

  createEffect(() => {
    filter()
    setStore("selected", 0)
  })

  function move(direction: -1 | 1) {
    if (!store.visible) return
    const opts = options()
    if (!opts.length) return
    let next = store.selected + direction
    if (next < 0) next = opts.length - 1
    if (next >= opts.length) next = 0
    let attempts = 0
    while (opts[next]?.isHeader && attempts < opts.length) {
      next = (next + direction + opts.length) % opts.length
      attempts++
    }
    moveTo(next)
  }

  function moveTo(next: number) {
    setStore("selected", next)
    if (!scroll) return
    const viewportHeight = Math.min(height(), options().length)
    const scrollBottom = scroll.scrollTop + viewportHeight
    if (next < scroll.scrollTop) {
      scroll.scrollBy(next - scroll.scrollTop)
    } else if (next + 1 > scrollBottom) {
      scroll.scrollBy(next + 1 - scrollBottom)
    }
  }

  function select() {
    const selected = options()[store.selected]
    if (!selected || selected.isHeader) return
    hide()
    selected.onSelect?.()
  }

  function expandDirectory() {
    const selected = options()[store.selected]
    if (!selected) return

    const input = props.input()
    const currentCursorOffset = input.cursorOffset

    const displayText = selected.display.trimEnd()
    const path = displayText.startsWith("@") ? displayText.slice(1) : displayText

    input.cursorOffset = store.index
    const startCursor = input.logicalCursor
    input.cursorOffset = currentCursorOffset
    const endCursor = input.logicalCursor

    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    input.insertText("@" + path)

    setStore("selected", 0)
  }

  function show(mode: "@" | "/") {
    command.keybinds(false)
    setStore({
      visible: mode,
      index: props.input().cursorOffset,
    })
  }

  function hide() {
    const text = props.input().plainText
    if (store.visible === "/" && !text.endsWith(" ") && text.startsWith("/")) {
      const cursor = props.input().logicalCursor
      props.input().deleteRange(0, 0, cursor.row, cursor.col)
      // Sync the prompt store immediately since onContentChange is async
      props.setPrompt((draft) => {
        draft.input = props.input().plainText
      })
    }
    command.keybinds(true)
    setStore("visible", false)
  }

  onMount(() => {
    props.ref({
      get visible() {
        return store.visible
      },
      onInput(value) {
        if (store.visible) {
          if (
            // Typed text before the trigger
            props.input().cursorOffset <= store.index ||
            // There is a space between the trigger and the cursor
            props.input().getTextRange(store.index, props.input().cursorOffset).match(/\s/) ||
            // "/<command>" is not the sole content
            (store.visible === "/" && value.match(/^\S+\s+\S+\s*$/))
          ) {
            hide()
          }
          return
        }

        // Check if autocomplete should reopen (e.g., after backspace deleted a space)
        const offset = props.input().cursorOffset
        if (offset === 0) return

        // Check for "/" at position 0 - reopen slash commands
        if (value.startsWith("/") && !value.slice(0, offset).match(/\s/)) {
          show("/")
          setStore("index", 0)
          return
        }

        // Check for "@" trigger - find the nearest "@" before cursor with no whitespace between
        const text = value.slice(0, offset)
        const idx = text.lastIndexOf("@")
        if (idx === -1) return

        const between = text.slice(idx)
        const before = idx === 0 ? undefined : value[idx - 1]
        if ((before === undefined || /\s/.test(before)) && !between.match(/\s/)) {
          show("@")
          setStore("index", idx)
        }
      },
      onKeyDown(e: KeyEvent) {
        if (store.visible) {
          const name = e.name?.toLowerCase()
          const ctrlOnly = e.ctrl && !e.meta && !e.shift
          const isNavUp = name === "up" || (ctrlOnly && name === "p")
          const isNavDown = name === "down" || (ctrlOnly && name === "n")

          if (isNavUp) {
            setStore("input", "keyboard")
            move(-1)
            e.preventDefault()
            return
          }
          if (isNavDown) {
            setStore("input", "keyboard")
            move(1)
            e.preventDefault()
            return
          }
          if (name === "escape") {
            hide()
            e.preventDefault()
            return
          }
          if (name === "return") {
            select()
            e.preventDefault()
            return
          }
          if (name === "tab") {
            const selected = options()[store.selected]
            if (selected?.isDirectory) {
              expandDirectory()
            } else {
              select()
            }
            e.preventDefault()
            return
          }
        }
        if (!store.visible) {
          if (e.name === "@") {
            const cursorOffset = props.input().cursorOffset
            const charBeforeCursor =
              cursorOffset === 0 ? undefined : props.input().getTextRange(cursorOffset - 1, cursorOffset)
            const canTrigger = charBeforeCursor === undefined || charBeforeCursor === "" || /\s/.test(charBeforeCursor)
            if (canTrigger) show("@")
          }

          if (e.name === "/") {
            if (props.input().cursorOffset === 0) show("/")
          }
        }
      },
    })
  })

  const height = createMemo(() => {
    const count = options().length || 1
    if (!store.visible) return Math.min(10, count)
    positionTick()
    return Math.min(10, count, Math.max(1, props.anchor().y))
  })

  let scroll: ScrollBoxRenderable

  // Render the dropdown through the overlay portal at the session's main box, as a sibling of the scrollbox, so its
  // zIndex covers the conversation.
  onMount(() => {
    overlay.set(() => (
      <box
        visible={store.visible !== false}
        position="absolute"
        top={position().y - height()}
        left={position().x}
        width={position().width}
        zIndex={100}
        border={["top", "left", "right"]}
        customBorderChars={{
          topLeft: "┌",
          topRight: "┐",
          bottomLeft: " ",
          bottomRight: " ",
          vertical: "│",
          horizontal: "─",
          topT: "┬",
          bottomT: " ",
          leftT: "├",
          rightT: "┤",
          cross: "┼",
        }}
        borderColor={theme.border}
        backgroundColor={theme.backgroundMenu}
      >
        <scrollbox
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          backgroundColor={theme.backgroundMenu}
          height={height()}
          scrollbarOptions={{ visible: false }}
        >
          <Index
            each={options()}
            fallback={
              <box paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundMenu}>
                <text fg={theme.textMuted}>{locale.t("autocomplete.noMatches")}</text>
              </box>
            }
          >
            {(option, index) => (
              <Show
                when={option().isHeader}
                fallback={
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={index === store.selected ? theme.primary : theme.backgroundMenu}
                    flexDirection="row"
                    onMouseMove={() => {
                      setStore("input", "mouse")
                    }}
                    onMouseOver={() => {
                      if (store.input !== "mouse") return
                      moveTo(index)
                    }}
                    onMouseDown={() => {
                      setStore("input", "mouse")
                      moveTo(index)
                    }}
                    onMouseUp={() => select()}
                  >
                    <text fg={index === store.selected ? selectedForeground(theme) : theme.text} flexShrink={0}>
                      {option().display}
                    </text>
                    <Show when={option().description}>
                      <text fg={index === store.selected ? selectedForeground(theme) : theme.textMuted} wrapMode="none">
                        {option().description}
                      </text>
                    </Show>
                  </box>
                }
              >
                <box paddingLeft={1} paddingRight={1} flexDirection="row">
                  <text fg={theme.textMuted}>{"── " + option().display + " ──"}</text>
                </box>
              </Show>
            )}
          </Index>
        </scrollbox>
      </box>
    ))

    onCleanup(() => overlay.clear())
  })

  return <></>
}
