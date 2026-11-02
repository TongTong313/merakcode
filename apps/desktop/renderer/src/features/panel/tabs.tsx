import { Popover } from "@kobalte/core/popover"
import ChevronDown from "lucide-solid/icons/chevron-down"
import X from "lucide-solid/icons/x"
import { createSignal, For } from "solid-js"
import { t } from "../../i18n"
import { trackOverlay } from "../../ui/overlay"
import type { PanelTab } from "./state"

/** The overflow list keeps activation and guarded closing available for every hidden tab. */
export function TabOverview(props: {
  tabs: PanelTab[]
  active?: string
  busy: boolean
  label: (tab: PanelTab) => string
  activate: (id: string) => void
  close: (tab: PanelTab) => void
}) {
  const [open, setOpen] = createSignal(false)
  trackOverlay(open)
  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-end" gutter={4}>
      <Popover.Trigger class="icon-button" aria-label={t("panel.allTabs")}>
        <ChevronDown class="icon icon-sm" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="popover tab-overview">
          <Popover.Title class="sr-only">{t("panel.allTabs")}</Popover.Title>
          <For each={props.tabs}>
            {(tab) => (
              <div class="row">
                <button
                  class="menu-item grow"
                  aria-pressed={props.active === tab.id}
                  onClick={() => {
                    props.activate(tab.id)
                    setOpen(false)
                  }}
                >
                  {props.label(tab)}
                </button>
                <button
                  class="icon-button"
                  aria-label={t("panel.closeTab", { name: props.label(tab) })}
                  disabled={props.busy}
                  onClick={() => props.close(tab)}
                >
                  <X class="icon icon-sm" />
                </button>
              </div>
            )}
          </For>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
