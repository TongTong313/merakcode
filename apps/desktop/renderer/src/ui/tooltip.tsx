import { Tooltip as Kobalte } from "@kobalte/core/tooltip"
import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js"

/**
 * The tooltip layer writes its own inline pointer-events value.
 * Put clicks back through the hint and its positioning frame.
 */
function passClicksThrough(node: HTMLElement) {
  const apply = () => {
    if (
      node.style.getPropertyValue("pointer-events") !== "none" ||
      node.style.getPropertyPriority("pointer-events") !== "important"
    )
      node.style.setProperty("pointer-events", "none", "important")
    const frame = node.parentElement
    if (!frame?.hasAttribute("data-popper-positioner")) return
    if (
      frame.style.getPropertyValue("pointer-events") === "none" &&
      frame.style.getPropertyPriority("pointer-events") === "important"
    )
      return
    frame.style.setProperty("pointer-events", "none", "important")
  }
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(node, { attributes: true, attributeFilter: ["style"] })
  onCleanup(() => observer.disconnect())
}

/** Hover tooltip, visual only; the button still needs its own aria-label */
export function Tip(props: { label: string; keys?: string; children: JSX.Element; placement?: "top" | "bottom" }) {
  const [content, setContent] = createSignal<HTMLElement>()
  createEffect(() => {
    const node = content()
    if (node) passClicksThrough(node)
  })
  return (
    <Kobalte openDelay={500} closeDelay={0} placement={props.placement ?? "bottom"} gutter={6}>
      <Kobalte.Trigger as="span" class="tip">
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content class="tooltip" ref={setContent}>
          {props.label}
          <Show when={props.keys}>
            <For each={props.keys!.split(" ")}>{(key) => <kbd>{key}</kbd>}</For>
          </Show>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
