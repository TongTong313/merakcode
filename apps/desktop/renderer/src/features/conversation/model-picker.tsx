import { Popover } from "@kobalte/core/popover"
import ChevronDown from "lucide-solid/icons/chevron-down"
import { createMemo, createSignal, For, Show } from "solid-js"
import { locale, t } from "../../i18n"
import { available, find, modelKey, type ModelRef } from "../../state/models"
import { setUi } from "../../state/ui"
import { trackOverlay } from "../../ui/overlay"
import { Tip } from "../../ui/tooltip"
import { providerLabel } from "../../ui/provider-label"
import { pickerSections } from "./model-picker-list"

/** Model picker: search by name or provider, arrow keys to move, Enter to select */
export function ModelPicker(props: {
  value: ModelRef | undefined
  onChange: (model: ModelRef) => void
  disabled?: boolean
}) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  trackOverlay(open)
  const current = () => find(props.value)
  const currentKey = () => (props.value ? modelKey(props.value) : undefined)
  const rows = createMemo(() => {
    const sections = pickerSections(
      available(),
      currentKey(),
      {
        configured: t("model.section.configured"),
        official: t("model.section.official"),
      },
      query(),
    )
    let index = 0
    return sections.flatMap((section) => [
      { kind: "title" as const, title: section.title },
      ...section.items.map((item) => ({ kind: "model" as const, item, index: index++ })),
    ])
  })
  const choices = () => rows().flatMap((row) => (row.kind === "model" ? [row] : []))
  const pick = (index: number) => {
    if (props.disabled) return
    const item = choices()[index]?.item
    if (!item) return
    props.onChange({ providerID: item.provider.id, modelID: item.model.id })
    setOpen(false)
  }
  const key = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setActive((index) => Math.min(Math.max(0, index + step), Math.max(0, choices().length - 1)))
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
            choices().findIndex((row) => row.item.key === currentKey()),
          ),
        )
      }}
      placement="top-end"
      gutter={6}
    >
      <Tip label={t("model.hint")} placement="top">
        <Popover.Trigger
          class="chip"
          disabled={props.disabled}
          aria-label={t("model.named", { name: current()?.model.name ?? t("model.none") })}
        >
          <span class="ellipsis">{current()?.model.name ?? t("model.none")}</span>
          <ChevronDown class="icon chevron" />
        </Popover.Trigger>
      </Tip>
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
            <Show when={choices().length} fallback={<div class="menu-item subtle">{t("model.none")}</div>}>
              <For each={rows()}>
                {(row) => (
                  <Show
                    when={row.kind === "model" ? row : undefined}
                    fallback={<div class="menu-group-label">{row.kind === "title" ? row.title : ""}</div>}
                  >
                    {(model) => (
                      <div
                        id={`model-option-${model().index}`}
                        class="menu-item"
                        role="option"
                        aria-selected={model().item.key === currentKey()}
                        data-highlighted={model().index === active() ? "" : undefined}
                        onMouseEnter={() => setActive(model().index)}
                        onClick={() => pick(model().index)}
                      >
                        <span class="ellipsis">{model().item.model.name}</span>
                        <span class="desc ellipsis">{providerLabel(model().item.provider, locale())}</span>
                      </div>
                    )}
                  </Show>
                )}
              </For>
            </Show>
          </div>
          <button
            type="button"
            class="menu-item model-add"
            onClick={() => {
              setOpen(false)
              setUi("settings", "models")
            }}
          >
            {t("model.add")}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
