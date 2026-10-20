import { InputRenderable, RGBA, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTheme, selectedForeground } from "../context/theme"
import { entries, filter, flatMap, groupBy, pipe } from "remeda"
import { batch, createEffect, createMemo, For, onCleanup, Show, type JSX, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useTerminalDimensions } from "@opentui/solid"
import fuzzysort from "fuzzysort"
import { isDeepEqual } from "remeda"
import { useDialog, useDialogKeyboard, type DialogContext } from "./dialog"
import { useKeybind } from "../context/keybind"
import { Keybind } from "@merakcode/util/keybind"
import { Locale } from "@merakcode/util/locale"
import { useLocale } from "../context/locale"
import { findDialogSelectOptionIndex, findDialogSelectValueIndex } from "./dialog-select-state"

export interface DialogSelectProps<T> {
  title: string
  placeholder?: string
  options: DialogSelectOption<T>[]
  flat?: boolean
  ref?: (ref: DialogSelectRef<T>) => void
  onMove?: (option: DialogSelectOption<T>) => void
  onFilter?: (query: string) => void
  onSelect?: (option: DialogSelectOption<T>) => void
  skipFilter?: boolean
  /** Keeps the selection by value when the list reorders (e.g. pinning); scrolls at edges without centering. */
  preserveSelection?: boolean
  keybind?: {
    keybind?: Keybind.Info
    title: string
    disabled?: boolean
    onTrigger: (option: DialogSelectOption<T>) => void
  }[]
  current?: T
}

export interface DialogSelectOption<T = any> {
  title: string
  value: T
  description?: string
  footer?: JSX.Element | string
  category?: string
  disabled?: boolean
  bg?: RGBA
  gutter?: JSX.Element
  onSelect?: (ctx: DialogContext) => void
}

export type DialogSelectRef<T> = {
  filter: string
  filtered: DialogSelectOption<T>[]
  moveTo(value: T, center?: boolean): void
}

export function DialogSelect<T>(props: DialogSelectProps<T>) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const locale = useLocale()
  const [store, setStore] = createStore({
    selected: 0,
    filter: "",
    input: "keyboard" as "keyboard" | "mouse",
  })

  // Only for preserveSelection: tracks the selection in a closure instead of the store (as in OpenCode).
  let selection: { value: T; category?: string } | undefined
  let resetSelection = false
  let visibilityGeneration = 0

  createEffect(
    on(
      () => props.current,
      (current) => {
        if (current) {
          const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
          if (currentIndex >= 0) {
            setStore("selected", currentIndex)
            selection = flat()[currentIndex]
          }
        }
      },
    ),
  )

  let input: InputRenderable
  let scroll: ScrollBoxRenderable | undefined

  const filtered = createMemo(() => {
    if (props.skipFilter) return props.options.filter((x) => x.disabled !== true)
    const needle = store.filter.toLowerCase()
    const options = pipe(
      props.options,
      filter((x) => x.disabled !== true),
    )
    if (!needle) return options

    const result = fuzzysort
      .go(needle, options, {
        keys: ["title", "category"],
        limit: 0,
        threshold: 0,
        scoreFn: (r) => r[0].score * 2 + r[1].score,
      })
      .map((x) => x.obj)

    return result
  })

  // Force keyboard mode when the filter changes, so layout shifting under the cursor does not fire synthetic hovers.
  createEffect(() => {
    filtered()
    setStore("input", "keyboard")
  })

  const flatten = createMemo(() => props.flat && store.filter.length > 0)

  const grouped = createMemo<[string, DialogSelectOption<T>[]][]>(() => {
    if (flatten()) return [["", filtered()]]
    const result = pipe(
      filtered(),
      groupBy((x) => x.category ?? ""),
      entries(),
    )
    return result
  })

  const flat = createMemo(() => {
    return pipe(
      grouped(),
      flatMap(([_, options]) => options),
    )
  })

  const rows = createMemo(() => {
    const headers = grouped().reduce((acc, [category], i) => {
      if (!category) return acc
      return acc + (i > 0 ? 2 : 1)
    }, 0)
    return flat().length + headers
  })

  const dimensions = useTerminalDimensions()
  const height = createMemo(() => Math.min(rows(), Math.floor(dimensions().height / 2) - 6))

  const selected = createMemo(() => flat()[store.selected])

  // preserveSelection only: after options reorder, follow the selected value and scroll at edges without centering.
  createEffect(
    on(
      () => props.options,
      () => {
        if (!props.preserveSelection) return
        if (resetSelection && store.filter.length > 0) {
          const option = flat()[0]
          if (!option) return
          setStore("selected", 0)
          selection = option
          return
        }
        if (!selection) {
          if (props.current !== undefined) {
            const index = flat().findIndex((option) => isDeepEqual(option.value, props.current))
            if (index >= 0) {
              setStore("selected", index)
              selection = flat()[index]
              return
            }
          }
          const option = selected()
          if (!option) return
          selection = option
          return
        }
        const previous = selection
        const index = flat().findIndex((option) => isDeepEqual(option.value, previous.value))
        if (index >= 0) {
          const option = flat()[index]
          const moved = index !== store.selected || option.category !== previous.category
          setStore("selected", index)
          selection = option
          if (!moved) return
          const value = option.value
          const generation = ++visibilityGeneration
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (generation !== visibilityGeneration) return
              if (!props.preserveSelection || store.filter.length > 0) return
              if (!isDeepEqual(selected()?.value, value)) return
              scrollToSelection(false)
            })
          })
          return
        }
        const next = Math.min(store.selected, flat().length - 1)
        if (next < 0) return
        setStore("selected", next)
        selection = flat()[next]
      },
    ),
  )
  onCleanup(() => {
    visibilityGeneration++
    scroll = undefined
  })

  createEffect(
    on([() => store.filter, () => props.current], ([filter, current]) => {
      if (filter.length > 0) resetSelection = true
      setTimeout(() => {
        if (filter.length > 0) {
          moveTo(0, true, false)
        } else if (current) {
          const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
          if (currentIndex >= 0) {
            moveTo(currentIndex, true)
          }
        }
      }, 0)
    }),
  )

  function move(direction: number) {
    if (flat().length === 0) return
    let next = store.selected + direction
    if (next < 0) next = flat().length - 1
    if (next >= flat().length) next = 0
    moveTo(next, true)
  }

  /**
   * center=false: mouse hover, only scrolls at the viewport edges
   * center=true: keyboard navigation or initial positioning, scrolls to center
   * preserve=false: search reset, drops the tracked selection
   */
  function moveTo(next: number, center = false, preserve = true) {
    setStore("selected", next)
    const option = selected()
    if (option) {
      selection = option
      resetSelection = !preserve
    }
    if (option) props.onMove?.(option)
    scrollToSelection(center)
  }

  /** Finds the scroll target by row index, not JSON id, so reordering recents does not scroll to the wrong row. */
  function scrollToSelection(center: boolean) {
    if (!scroll || scroll.isDestroyed) return
    let remaining = store.selected
    let index = 0
    for (const [category, options] of grouped()) {
      if (category) index++
      if (remaining < options.length) {
        index += remaining
        break
      }
      index += options.length
      remaining -= options.length
    }
    const target = scroll.getChildren()[index]
    if (!target) return
    const y = target.y - scroll.y
    if (center) {
      const centerOffset = Math.floor(scroll.height / 2)
      scroll.scrollBy(y - centerOffset)
      return
    }
    if (y >= scroll.height) {
      scroll.scrollBy(y - scroll.height + 1)
    }
    if (y < 0) {
      scroll.scrollBy(y)
      if (isDeepEqual(flat()[0].value, selected()?.value)) {
        scroll.scrollTo(0)
      }
    }
  }

  const keybind = useKeybind()
  useDialogKeyboard((evt) => {
    setStore("input", "keyboard")

    for (const item of props.keybind ?? []) {
      if (item.disabled || !item.keybind) continue
      if (Keybind.match(item.keybind, keybind.parse(evt))) {
        const s = selected()
        if (s) {
          evt.preventDefault()
          evt.stopPropagation()
          item.onTrigger(s)
        }
        return
      }
    }

    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) move(-1)
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) move(1)
    if (evt.name === "pageup") move(-10)
    if (evt.name === "pagedown") move(10)
    if (evt.name === "home") moveTo(0, true)
    if (evt.name === "end") moveTo(flat().length - 1, true)

    if (evt.name === "return") {
      const option = selected()
      if (option) {
        evt.preventDefault()
        evt.stopPropagation()
        if (option.onSelect) option.onSelect(dialog)
        props.onSelect?.(option)
      }
    }
  })

  const ref: DialogSelectRef<T> = {
    get filter() {
      return store.filter
    },
    get filtered() {
      return filtered()
    },
    moveTo(value: T, center = true) {
      const index = findDialogSelectValueIndex(flat(), value)
      if (index >= 0) moveTo(index, center)
    },
  }
  props.ref?.(ref)

  const keybinds = createMemo(() => props.keybind?.filter((x) => !x.disabled && x.keybind) ?? [])

  return (
    <box gap={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={4}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {props.title}
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
        <Show when={!props.skipFilter || props.onFilter}>
          <box paddingTop={1}>
            <input
              onInput={(e) => {
                batch(() => {
                  setStore("filter", e)
                  props.onFilter?.(e)
                })
              }}
              focusedBackgroundColor={theme.backgroundPanel}
              cursorColor={theme.primary}
              focusedTextColor={theme.textMuted}
              ref={(r) => {
                input = r
                setTimeout(() => {
                  if (!input) return
                  if (input.isDestroyed) return
                  input.focus()
                }, 1)
              }}
              placeholder={props.placeholder ?? locale.t("select.search")}
            />
          </box>
        </Show>
      </box>
      <Show
        when={grouped().length > 0}
        fallback={
          <box paddingLeft={4} paddingRight={4} paddingTop={1}>
            <text fg={theme.textMuted}>{locale.t("select.noResults")}</text>
          </box>
        }
      >
        <scrollbox
          paddingLeft={1}
          paddingRight={1}
          scrollbarOptions={{ visible: false }}
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          maxHeight={height()}
        >
          <For each={grouped()}>
            {([category, options], index) => (
              <>
                <Show when={category}>
                  <box paddingTop={index() > 0 ? 1 : 0} paddingLeft={3}>
                    <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                      {category}
                    </text>
                  </box>
                </Show>
                <For each={options}>
                  {(option) => {
                    const active = createMemo(() => option === selected())
                    const current = createMemo(() => isDeepEqual(option.value, props.current))
                    return (
                      <box
                        flexDirection="column"
                        onMouseMove={() => {
                          setStore("input", "mouse")
                        }}
                        onMouseUp={() => {
                          option.onSelect?.(dialog)
                          props.onSelect?.(option)
                        }}
                        onMouseOver={() => {
                          if (store.input !== "mouse") return
                          const index = findDialogSelectOptionIndex(flat(), option)
                          if (index === -1) return
                          // center=false: move the highlight and scroll at edges only, no paging.
                          moveTo(index)
                        }}
                        onMouseDown={() => {
                          const index = findDialogSelectOptionIndex(flat(), option)
                          if (index === -1) return
                          moveTo(index)
                        }}
                      >
                        <box
                          flexDirection="row"
                          backgroundColor={active() ? (option.bg ?? theme.primary) : RGBA.fromInts(0, 0, 0, 0)}
                          paddingLeft={current() || option.gutter ? 1 : 3}
                          paddingRight={3}
                          gap={1}
                        >
                          <Option
                            title={option.title}
                            footer={flatten() ? (option.category ?? option.footer) : option.footer}
                            description={option.description !== category ? option.description : undefined}
                            active={active()}
                            current={current()}
                            gutter={option.gutter}
                          />
                        </box>
                      </box>
                    )
                  }}
                </For>
              </>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show when={keybinds().length} fallback={<box flexShrink={0} />}>
        <box paddingRight={2} paddingLeft={4} flexDirection="row" gap={2} flexShrink={0} paddingTop={1}>
          <For each={keybinds()}>
            {(item) => (
              <text>
                <span style={{ fg: theme.text }}>
                  <b>{item.title}</b>{" "}
                </span>
                <span style={{ fg: theme.textMuted }}>{Keybind.toString(item.keybind)}</span>
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

function Option(props: {
  title: string
  description?: string
  active?: boolean
  current?: boolean
  footer?: JSX.Element | string
  gutter?: JSX.Element
  onMouseOver?: () => void
}) {
  const { theme } = useTheme()
  const fg = selectedForeground(theme)

  return (
    <>
      <Show when={props.current}>
        <text flexShrink={0} fg={props.active ? fg : props.current ? theme.primary : theme.text} marginRight={0}>
          ●
        </text>
      </Show>
      <Show when={!props.current && props.gutter}>
        <box flexShrink={0} marginRight={0}>
          {props.gutter}
        </box>
      </Show>
      <text
        flexGrow={1}
        fg={props.active ? fg : props.current ? theme.primary : theme.text}
        attributes={props.active ? TextAttributes.BOLD : undefined}
        overflow="hidden"
        wrapMode="none"
        paddingLeft={3}
      >
        {Locale.truncate(props.title, 80)}
        <Show when={props.description}>
          <span style={{ fg: props.active ? fg : theme.textMuted }}> {props.description}</span>
        </Show>
      </text>
      <Show when={props.footer}>
        <box flexShrink={0}>
          <text fg={props.active ? fg : theme.textMuted}>{props.footer}</text>
        </box>
      </Show>
    </>
  )
}
