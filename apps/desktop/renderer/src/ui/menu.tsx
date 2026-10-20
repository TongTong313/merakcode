import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { createSignal, For, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { trackOverlay } from "./overlay"

export type MenuItem =
  | {
      label: string
      icon?: (props: { class?: string }) => JSX.Element
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | "separator"

/** Dropdown menu: trigger is the trigger button's content, label its accessible name */
export function Menu(props: { label: string; trigger: JSX.Element; items: MenuItem[]; class?: string }) {
  const [open, setOpen] = createSignal(false)
  trackOverlay(open)
  return (
    <DropdownMenu open={open()} onOpenChange={setOpen} gutter={4} placement="bottom-end">
      <DropdownMenu.Trigger class={props.class ?? "icon-button"} aria-label={props.label}>
        {props.trigger}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="popover">
          <For each={props.items}>
            {(item) =>
              item === "separator" ? (
                <DropdownMenu.Separator class="menu-separator" />
              ) : (
                <DropdownMenu.Item
                  class={item.danger ? "menu-item danger del" : "menu-item"}
                  disabled={item.disabled}
                  onSelect={item.onSelect}
                >
                  <Show when={item.icon}>{(icon) => <Dynamic component={icon()} class="icon icon-sm" />}</Show>
                  {item.label}
                </DropdownMenu.Item>
              )
            }
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
