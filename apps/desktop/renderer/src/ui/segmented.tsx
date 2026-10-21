import { For, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Tip } from "./tooltip"

/**
 * Segmented control (radiogroup): arrow keys move and select; Tab stops only on the selected option, or the first
 * available one when the value is not among the options. An unavailable option stays hoverable so its hint can say
 * why. children go after the options, e.g. a dropdown that acts as one more option.
 */
export function Segmented<T extends string>(props: {
  label: string
  options: {
    value: T
    label: string
    icon?: (props: { class?: string }) => JSX.Element
    disabled?: boolean
    hint?: string
  }[]
  value: T
  onChange: (value: T) => void
  children?: JSX.Element
}) {
  let group!: HTMLDivElement
  const enabled = () => props.options.filter((option) => !option.disabled)
  const stop = () => (props.options.some((option) => option.value === props.value) ? props.value : enabled()[0]?.value)
  const move = (event: KeyboardEvent, index: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0
    if (!step) return
    event.preventDefault()
    const list = enabled()
    const current = list.findIndex((option) => option.value === props.options[index]!.value)
    const next = list[(current + step + list.length) % list.length]!
    props.onChange(next.value)
    queueMicrotask(() => group.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus())
  }
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label} ref={group}>
      <For each={props.options}>
        {(option, index) => {
          const button = (
            <button
              type="button"
              role="radio"
              aria-checked={option.value === props.value}
              aria-disabled={option.disabled || undefined}
              aria-description={option.hint}
              tabIndex={option.value === stop() ? 0 : -1}
              onClick={() => !option.disabled && props.onChange(option.value)}
              onKeyDown={(event) => move(event, index())}
            >
              <Show when={option.icon}>{(icon) => <Dynamic component={icon()} class="icon icon-xs" />}</Show>
              {option.label}
            </button>
          )
          return option.hint ? <Tip label={option.hint}>{button}</Tip> : button
        }}
      </For>
      {props.children}
    </div>
  )
}
