import { Tooltip as Kobalte } from "@kobalte/core/tooltip"
import { For, Show, type JSX } from "solid-js"

/** Hover tooltip, visual only; the button still needs its own aria-label */
export function Tip(props: { label: string; keys?: string; children: JSX.Element; placement?: "top" | "bottom" }) {
  return (
    <Kobalte openDelay={500} closeDelay={0} placement={props.placement ?? "bottom"} gutter={6}>
      <Kobalte.Trigger as="span" style={{ display: "contents" }}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content class="tooltip">
          {props.label}
          <Show when={props.keys}>
            <For each={props.keys!.split(" ")}>{(key) => <kbd>{key}</kbd>}</For>
          </Show>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
