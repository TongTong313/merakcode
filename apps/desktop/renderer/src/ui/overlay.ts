import { createEffect, createSignal, onCleanup } from "solid-js"

/**
 * Number of open overlays (dialogs, menus, dropdowns). The browser panel's page is a native view laid over the UI, so
 * it must hide while an overlay is open or it would cover it.
 */
const [count, setCount] = createSignal(0)
export const overlays = count

/** Counts as one open overlay while open() is true */
export function trackOverlay(open: () => boolean) {
  createEffect(() => {
    if (!open()) return
    setCount((value) => value + 1)
    onCleanup(() => setCount((value) => value - 1))
  })
}
