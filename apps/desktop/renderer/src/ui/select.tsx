import { Select as Kobalte } from "@kobalte/core/select"
import ChevronDown from "lucide-solid/icons/chevron-down"
import Check from "lucide-solid/icons/check"
import { createSignal, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { trackOverlay } from "./overlay"

export type Option<T extends string = string> = {
  value: T
  label: string
  description?: string
  icon?: (props: { class?: string }) => JSX.Element
  group?: string
}

/**
 * Dropdown select (Kobalte Select). The trigger's accessible name is label plus the current value, e.g.
 * "Permission mode Ask".
 */
export function Select<T extends string>(props: {
  label: string
  options: Option<T>[]
  value: T | undefined
  onChange: (value: T) => void
  placeholder?: string
  class?: string
  /** Content of the trigger button; defaults to the selected option's icon and text */
  display?: (option: Option<T> | undefined) => JSX.Element
  disabled?: boolean
}) {
  const [open, setOpen] = createSignal(false)
  trackOverlay(open)
  const selected = () => props.options.find((option) => option.value === props.value)
  return (
    <Kobalte<Option<T>>
      options={props.options}
      optionValue="value"
      optionTextValue="label"
      value={selected() ?? null}
      onChange={(option) => option && props.onChange(option.value)}
      open={open()}
      onOpenChange={setOpen}
      disabled={props.disabled}
      placeholder={props.placeholder}
      gutter={4}
      placement="bottom-start"
      itemComponent={(item) => (
        <Kobalte.Item item={item.item} class="menu-item">
          <Show when={item.item.rawValue.icon}>
            {(icon) => <Dynamic component={icon()} class="icon icon-sm muted" />}
          </Show>
          <span>
            <Kobalte.ItemLabel>{item.item.rawValue.label}</Kobalte.ItemLabel>
            <Show when={item.item.rawValue.description}>
              <Kobalte.ItemDescription class="desc">{item.item.rawValue.description}</Kobalte.ItemDescription>
            </Show>
          </span>
          <Kobalte.ItemIndicator class="check">
            <Check class="icon icon-sm" />
          </Kobalte.ItemIndicator>
        </Kobalte.Item>
      )}
    >
      <Kobalte.Trigger class={props.class ?? "chip"} aria-label={props.label}>
        <Kobalte.Value<Option<T>> class="select-value">
          {(state) =>
            props.display ? (
              props.display(state.selectedOption())
            ) : (
              <>
                <Show when={state.selectedOption()?.icon}>
                  {(icon) => <Dynamic component={icon()} class="icon icon-sm" />}
                </Show>
                <span class="ellipsis">{state.selectedOption()?.label}</span>
              </>
            )
          }
        </Kobalte.Value>
        <Kobalte.Icon>
          <ChevronDown class="icon chevron" />
        </Kobalte.Icon>
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content class="popover">
          <Kobalte.Listbox />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
