import { createContext, useContext, createSignal, Show, type ParentProps, type JSX } from "solid-js"

// Lightweight portal: lets children render floating content at the provider's level, since position="absolute" with
// zIndex cannot escape the parent container's bounds.
const ctx = createContext<{
  set: (render: () => JSX.Element) => void
  clear: () => void
}>()

export function useOverlay() {
  return useContext(ctx)!
}

export function OverlayProvider(props: ParentProps) {
  const [render, setRender] = createSignal<(() => JSX.Element) | null>(null)

  return (
    <ctx.Provider
      value={{
        set: (fn) => setRender(() => fn),
        clear: () => setRender(null),
      }}
    >
      {props.children}
      <Show when={render()}>{(fn) => fn()()}</Show>
    </ctx.Provider>
  )
}
