import { MouseButton, RGBA, type KeyEvent, type MouseEvent, type Renderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createContext, For, onCleanup, onMount, useContext, type JSX, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"

import { useTheme } from "../context/theme"
import { Selection } from "../util/selection"
import { useToast } from "./toast"
import { TuiFlags } from "../flags"

interface DialogProps {
  size?: "medium" | "large"
  onClose: () => void
  backgroundColor: RGBA
  visible?: boolean
}

function Dialog(props: ParentProps<DialogProps>) {
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()

  let dismiss = false

  return (
    <box
      onMouseDown={() => {
        dismiss = !!renderer.getSelection()
      }}
      onMouseUp={() => {
        if (dismiss) {
          dismiss = false
          return
        }
        props.onClose()
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      position="absolute"
      paddingTop={dimensions().height / 4}
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
      visible={props.visible}
    >
      <box
        onMouseUp={(e) => {
          dismiss = false
          e.stopPropagation()
        }}
        width={props.size === "large" ? 80 : 60}
        maxWidth={dimensions().width - 2}
        backgroundColor={props.backgroundColor}
        paddingTop={1}
      >
        {props.children}
      </box>
    </box>
  )
}

type DialogElement = () => JSX.Element
type DialogKeyboard = (evt: KeyEvent) => void

interface DialogEntry {
  id: number
  element: DialogElement
  size: "medium" | "large"
  locked: boolean
  focus: Renderable | null
  close: () => void
}

function init() {
  const [store, setStore] = createStore({
    stack: [] as DialogEntry[],
  })

  const renderer = useRenderer()
  let next = 0
  let revision = 0
  let pendingLock = false
  const handlers = new Map<number, Set<DialogKeyboard>>()

  function create(
    input: DialogElement,
    onClose?: () => void,
    focus = renderer.currentFocusedRenderable,
    locked = false,
  ) {
    let closed = false
    return {
      id: next++,
      element: input,
      size: "medium" as const,
      locked,
      focus,
      close() {
        if (closed) return
        closed = true
        onClose?.()
      },
    }
  }

  function refocus(focus: Renderable | null) {
    const current = revision
    setTimeout(() => {
      if (current !== revision) return
      if (!focus) return
      if (focus.isDestroyed) return
      function find(item: Renderable) {
        for (const child of item.getChildren()) {
          if (child === focus) return true
          if (find(child)) return true
        }
        return false
      }
      const found = find(renderer.root)
      if (!found) return
      focus.focus()
    }, 1)
  }

  function pop() {
    const current = store.stack.at(-1)
    if (!current) return
    revision++
    setStore("stack", store.stack.slice(0, -1))
    current.close()
    refocus(current.focus)
  }

  useKeyboard((evt) => {
    const current = store.stack.at(-1)
    if (!current) return
    if (evt.defaultPrevented) return
    const dismiss = evt.name === "escape" || (evt.ctrl && evt.name === "c")
    if (dismiss && current.locked) {
      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    for (const handler of handlers.get(current.id) ?? []) {
      handler(evt)
      if (evt.propagationStopped) return
      if (store.stack.at(-1)?.id !== current.id) return
    }
    if (evt.defaultPrevented) return
    if (!dismiss) return
    if (renderer.getSelection()) return

    pop()
    evt.preventDefault()
    evt.stopPropagation()
  })

  const value = {
    clear() {
      const stack = store.stack.slice()
      if (stack.length === 0) return
      revision++
      setStore("stack", [])
      stack.toReversed().forEach((item) => item.close())
      refocus(stack[0]!.focus)
    },
    push(input: DialogElement, onClose?: () => void) {
      revision++
      const focus = renderer.currentFocusedRenderable
      focus?.blur()
      const locked = store.stack.length === 0 && pendingLock
      pendingLock = false
      setStore("stack", [...store.stack, create(input, onClose, focus, locked)])
    },
    pop,
    replace(input: DialogElement, onClose?: () => void) {
      if (store.stack.length === 0) {
        value.push(input, onClose)
        return
      }
      const current = store.stack.at(-1)!
      const close = current.close
      revision++
      setStore("stack", [...store.stack.slice(0, -1), create(input, onClose, current.focus, current.locked)])
      close()
    },
    lock() {
      if (store.stack.length === 0) {
        pendingLock = true
        return
      }
      setStore("stack", store.stack.length - 1, "locked", true)
    },
    unlock() {
      if (store.stack.length === 0) {
        pendingLock = false
        return
      }
      setStore("stack", store.stack.length - 1, "locked", false)
    },
    get locked() {
      return store.stack.at(-1)?.locked ?? pendingLock
    },
    get stack() {
      return store.stack
    },
    get size() {
      return store.stack.at(-1)?.size ?? "medium"
    },
    setSize(size: "medium" | "large") {
      if (store.stack.length === 0) return
      setStore("stack", store.stack.length - 1, "size", size)
    },
  }

  function subscribe(id: number, handler: DialogKeyboard) {
    const current = handlers.get(id) ?? new Set<DialogKeyboard>()
    current.add(handler)
    handlers.set(id, current)
    return () => {
      current.delete(handler)
      if (current.size === 0) handlers.delete(id)
    }
  }

  onCleanup(() => {
    revision++
    value.clear()
    handlers.clear()
  })
  return { value, subscribe }
}

type DialogState = ReturnType<typeof init>
export type DialogContext = DialogState["value"]

const ctx = createContext<DialogState>()
const scope = createContext<number>()

interface DialogStackProviderProps {
  backgroundColor: RGBA
  onMouseDown?: (evt: MouseEvent) => void
  onMouseUp?: (evt: MouseEvent) => void
}

export function DialogStackProvider(props: ParentProps<DialogStackProviderProps>) {
  const dialog = init()
  const value = dialog.value
  return (
    <ctx.Provider value={dialog}>
      {props.children}
      <box position="absolute" onMouseDown={props.onMouseDown} onMouseUp={props.onMouseUp}>
        <For each={value.stack}>
          {(entry) => (
            <scope.Provider value={entry.id}>
              <Dialog
                onClose={() => {
                  if (entry.id !== value.stack.at(-1)?.id) return
                  if (!entry.locked) value.pop()
                }}
                size={entry.size}
                backgroundColor={props.backgroundColor}
                visible={entry.id === value.stack.at(-1)?.id}
              >
                {entry.element()}
              </Dialog>
            </scope.Provider>
          )}
        </For>
      </box>
    </ctx.Provider>
  )
}

export function DialogProvider(props: ParentProps) {
  const renderer = useRenderer()
  const toast = useToast()
  const { theme } = useTheme()
  return (
    <DialogStackProvider
      backgroundColor={theme.backgroundPanel}
      onMouseDown={(evt) => {
        if (!TuiFlags.copyOnSelectDisabled) return
        if (evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast)) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={!TuiFlags.copyOnSelectDisabled ? () => Selection.copy(renderer, toast) : undefined}
    >
      {props.children}
    </DialogStackProvider>
  )
}

function useDialogState() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  return value
}

export function useDialog() {
  return useDialogState().value
}

export function useDialogKeyboard(callback: (evt: KeyEvent) => void) {
  const dialog = useDialogState()
  const id = useContext(scope)
  if (id === undefined) {
    useKeyboard(callback)
    return
  }
  let unsubscribe: (() => void) | undefined
  onMount(() => {
    unsubscribe = dialog.subscribe(id, callback)
  })
  onCleanup(() => unsubscribe?.())
}
