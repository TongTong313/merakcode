import { Popover } from "@kobalte/core/popover"
import Check from "lucide-solid/icons/check"
import ChevronDown from "lucide-solid/icons/chevron-down"
import Cpu from "lucide-solid/icons/cpu"
import { createMemo, createSignal, For, Show } from "solid-js"
import { t } from "../../i18n"
import { available, find, modelKey, type ModelRef } from "../../state/models"
import { trackOverlay } from "../../ui/overlay"

/** Model picker: search by name or provider, arrow keys to move, Enter to select */
export function ModelPicker(props: { value: ModelRef | undefined; onChange: (model: ModelRef) => void }) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  trackOverlay(open)
  const current = () => find(props.value)
  const list = createMemo(() => {
    const words = query().toLowerCase().split(/\s+/).filter(Boolean)
    return available().filter((item) => {
      const haystack = `${item.model.name} ${item.model.id} ${item.provider.name}`.toLowerCase()
      return words.every((word) => haystack.includes(word))
    })
  })
  const pick = (index: number) => {
    const item = list()[index]
    if (!item) return
    props.onChange({ providerID: item.provider.id, modelID: item.model.id })
    setOpen(false)
  }
  const key = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setActive((index) => Math.min(Math.max(0, index + step), list().length - 1))
      document.getElementById(`model-option-${active()}`)?.scrollIntoView({ block: "nearest" })
    }
    if (event.key === "Enter") {
      event.preventDefault()
      pick(active())
    }
  }
  return (
    <Popover
      open={open()}
      onOpenChange={(next) => {
        setOpen(next)
        setQuery("")
        setActive(
          Math.max(
            0,
            list().findIndex((item) => props.value && item.key === modelKey(props.value)),
          ),
        )
      }}
      placement="top-end"
      gutter={6}
    >
      <Popover.Trigger class="chip" aria-label={`${t("model.label")} ${current()?.model.name ?? ""}`.trim()}>
        <Cpu class="icon icon-sm" />
        <span class="ellipsis">{current()?.model.name ?? t("model.none")}</span>
        <ChevronDown class="icon chevron" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="popover model-picker">
          <input
            class="input"
            placeholder={t("model.search")}
            aria-label={t("model.search")}
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              setActive(0)
            }}
            onKeyDown={key}
            autofocus
          />
          <div class="model-list scroll" role="listbox" aria-label={t("model.label")}>
            <Show when={list().length} fallback={<div class="menu-item subtle">{t("model.none")}</div>}>
              <For each={list()}>
                {(item, index) => (
                  <div
                    id={`model-option-${index()}`}
                    class="menu-item"
                    role="option"
                    aria-selected={props.value ? item.key === modelKey(props.value) : false}
                    data-highlighted={index() === active() ? "" : undefined}
                    onMouseEnter={() => setActive(index())}
                    onClick={() => pick(index())}
                  >
                    <span class="ellipsis">{item.model.name}</span>
                    <span class="desc ellipsis">{item.provider.name}</span>
                    <Show when={props.value && item.key === modelKey(props.value)}>
                      <Check class="icon icon-sm check" />
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
