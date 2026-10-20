import { For, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"

/** Segmented control (radiogroup): arrow keys move and select; Tab stops only on the selected option */
export function Segmented<T extends string>(props: {
  label: string
  options: { value: T; label: string; icon?: (props: { class?: string }) => JSX.Element; disabled?: boolean }[]
  value: T
  onChange: (value: T) => void
}) {
  let group!: HTMLDivElement
  const move = (event: KeyboardEvent, index: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0
    if (!step) return
    event.preventDefault()
    const enabled = props.options.filter((option) => !option.disabled)
    const current = enabled.findIndex((option) => option.value === props.options[index]!.value)
    const next = enabled[(current + step + enabled.length) % enabled.length]!
    props.onChange(next.value)
    queueMicrotask(() => group.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus())
  }
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label} ref={group}>
      <For each={props.options}>
        {(option, index) => (
          <button
            type="button"
            role="radio"
            aria-checked={option.value === props.value}
            tabIndex={option.value === props.value ? 0 : -1}
            disabled={option.disabled}
            onClick={() => props.onChange(option.value)}
            onKeyDown={(event) => move(event, index())}
          >
            <Show when={option.icon}>{(icon) => <Dynamic component={icon()} class="icon icon-xs" />}</Show>
            {option.label}
          </button>
        )}
      </For>
    </div>
  )
}
