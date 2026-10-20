import { Show, type JSX } from "solid-js"

/** Switch (button role=switch) named by its text; with hideLabel the label is for screen readers only */
export function Switch(props: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hideLabel?: boolean
  children?: JSX.Element
  class?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      class={`switch ${props.class ?? ""}`}
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="switch-control" data-checked={props.checked ? "" : undefined}>
        <span class="switch-thumb" />
      </span>
      <span class={props.hideLabel ? "sr-only" : undefined}>{props.label}</span>
      <Show when={props.children}>{props.children}</Show>
    </button>
  )
}
