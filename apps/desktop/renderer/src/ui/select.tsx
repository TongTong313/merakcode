import { Select as Kobalte } from "@kobalte/core/select"
import ChevronDown from "lucide-solid/icons/chevron-down"
import Check from "lucide-solid/icons/check"
import { createSignal, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { trackOverlay } from "./overlay"
import { ProviderLogo } from "./provider-logo"

export type Option<T extends string = string> = {
  value: T
  label: string
  description?: string
  icon?: (props: { class?: string }) => JSX.Element
  /** Provider id. Built-in providers show their logo; any other id shows a letter. */
  providerID?: string
  group?: string
  disabled?: boolean
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
  placeholder?: JSX.Element
  class?: string
  /** Content of the trigger button; defaults to the selected option's icon and text */
  display?: (option: Option<T> | undefined) => JSX.Element
  disabled?: boolean
  onOpenChange?: (open: boolean) => void
  /** Pointer or focus reached the trigger, so the list may open soon: a chance to refresh the options */
  onPrepare?: () => void
}) {
  const [open, setOpen] = createSignal(false)
  trackOverlay(open)
  let trigger: HTMLButtonElement | undefined
  // Inside a modal dialog the list must open within it: the dialog hides everything outside from assistive tech
  const mount = () => trigger?.closest("[role=dialog]") ?? undefined
  const selected = () => props.options.find((option) => option.value === props.value)
  return (
    <Kobalte<Option<T>>
      options={props.options}
      optionValue="value"
      optionTextValue="label"
      optionDisabled="disabled"
      value={selected() ?? null}
      onChange={(option) => {
        if (option && option.value !== props.value) props.onChange(option.value)
      }}
      open={open()}
      onOpenChange={(value) => {
        setOpen(value)
        props.onOpenChange?.(value)
      }}
      disabled={props.disabled}
      placeholder={props.placeholder}
      gutter={4}
      placement="bottom-start"
      itemComponent={(item) => (
        <Kobalte.Item item={item.item} class="menu-item">
          <Show when={item.item.rawValue.providerID}>
            {(id) => <ProviderLogo id={id()} name={item.item.rawValue.description ?? ""} />}
          </Show>
          <Show when={item.item.rawValue.icon}>
            {(icon) => <Dynamic component={icon()} class="icon icon-sm muted" />}
          </Show>
          <div class="menu-item-copy">
            <Kobalte.ItemLabel class="ellipsis">{item.item.rawValue.label}</Kobalte.ItemLabel>
            <Show when={item.item.rawValue.description}>
              <Kobalte.ItemDescription class="desc">{item.item.rawValue.description}</Kobalte.ItemDescription>
            </Show>
          </div>
          <Kobalte.ItemIndicator class="check">
            <Check class="icon icon-sm" />
          </Kobalte.ItemIndicator>
        </Kobalte.Item>
      )}
    >
      <Kobalte.Trigger
        ref={trigger}
        class={props.class ?? "chip"}
        aria-label={props.label}
        onPointerEnter={() => props.onPrepare?.()}
        onFocus={() => props.onPrepare?.()}
      >
        <Kobalte.Value<Option<T>> class="select-value">
          {(state) =>
            props.display ? (
              props.display(state.selectedOption())
            ) : (
              <>
                <Show when={state.selectedOption()?.providerID}>
                  {(id) => <ProviderLogo id={id()} name={state.selectedOption()?.description ?? ""} />}
                </Show>
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
      <Kobalte.Portal mount={mount()}>
        <Kobalte.Content class="popover">
          <Kobalte.Listbox />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
