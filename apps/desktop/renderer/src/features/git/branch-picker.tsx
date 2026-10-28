import { Popover } from "@kobalte/core/popover"
import Check from "lucide-solid/icons/check"
import ChevronDown from "lucide-solid/icons/chevron-down"
import GitBranch from "lucide-solid/icons/git-branch"
import LoaderCircle from "lucide-solid/icons/loader-circle"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { t } from "../../i18n"
import {
  gitFailure,
  gitState,
  identityOf,
  refreshBranches,
  switchBranch,
  switchReason,
  switching,
} from "../../state/git"
import { trackOverlay } from "../../ui/overlay"
import { toast } from "../../ui/toast"

/** A starting point is a selection; switching updates the working checkout. */
export function BranchPicker(props: {
  directory: string
  purpose: "switch" | "start"
  value?: string | null
  disabled?: boolean
  onSelect?: (branch: string) => void
  onWorktree?: () => void
}) {
  const [open, setOpen] = createSignal(false)
  const [search, setSearch] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [error, setError] = createSignal<ReturnType<typeof gitFailure>>()
  const [items, setItems] = createSignal<{ name: string; worktree?: string }[]>([])
  let trigger!: HTMLButtonElement
  let input: HTMLInputElement | undefined
  let alive = true
  onCleanup(() => (alive = false))
  trackOverlay(open)
  const data = () => gitState(props.directory)
  const failure = () => error() ?? data()?.error
  const current = () => identityOf(props.directory)
  const value = () => (props.purpose === "switch" ? current()?.branch : props.value)
  const display = () => value() || (props.purpose === "switch" ? current()?.head?.slice(0, 7) : undefined)
  const label = () => t(`git.role.${props.purpose}`)
  const reason = () => (props.purpose === "switch" ? switchReason(props.directory) : undefined)
  const filtered = createMemo(() => items().filter((item) => item.name.toLowerCase().includes(search().toLowerCase())))
  createEffect(
    on(
      () => props.directory,
      () => {
        setOpen(false)
        setItems([])
        setSearch("")
      },
      { defer: true },
    ),
  )
  createEffect(() => {
    const options = data()?.options
    if (open() && options) setItems(options.branches)
  })
  const disabled = (item: { name: string; worktree?: string }) =>
    props.purpose === "switch" && (!!reason() || !!item.worktree || item.name === current()?.branch)
  const refresh = async () => {
    setError(undefined)
    const directory = props.directory
    const options = await refreshBranches(directory)
    if (alive && directory === props.directory && options) setItems(options.branches)
  }
  const choose = async (name: string) => {
    const directory = props.directory
    const item = filtered().find((option) => option.name === name)
    if (!item || disabled(item) || switching(props.directory)) return
    setError(undefined)
    try {
      if (props.purpose === "switch") {
        const result = await switchBranch(directory, name)
        if (!result || !alive || props.directory !== directory) return
        toast({ kind: "success", title: t("git.switched", { branch: name }) })
      } else props.onSelect?.(name)
      setOpen(false)
      trigger.focus()
    } catch (failure) {
      if (alive && props.directory === directory) setError(gitFailure(failure))
    }
  }
  const navigate = (event: KeyboardEvent) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
    if (step) {
      event.preventDefault()
      setSelected((index) => (index + step + filtered().length) % Math.max(1, filtered().length))
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const option = filtered()[selected()]
      if (option) void choose(option.name)
    }
  }
  return (
    <Popover
      open={open()}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) return
        setSearch("")
        setSelected(0)
        setError(undefined)
        setItems(data()?.options?.branches ?? [])
        void refresh()
      }}
      gutter={6}
      placement="bottom-start"
    >
      <Popover.Trigger
        ref={trigger}
        class="branch-chip"
        aria-label={`${label()} ${display() ?? t("git.choose")}`}
        title={`${label()}：${display() ?? t("git.choose")}`}
        disabled={props.disabled || switching(props.directory)}
        onPointerEnter={() => !open() && void refreshBranches(props.directory)}
        onFocus={() => !open() && void refreshBranches(props.directory)}
      >
        <Show when={switching(props.directory)} fallback={<GitBranch class="icon icon-xs" />}>
          <LoaderCircle class="icon icon-xs spinner" />
        </Show>
        <span class="ellipsis">
          {props.purpose === "start"
            ? t("compose.worktreeBase", { branch: display() ?? "…" })
            : (display() ?? t("git.choose"))}
        </span>
        <ChevronDown class="icon icon-xs subtle" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          class="popover branch-popover"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            input?.focus()
          }}
        >
          <Popover.Title class="branch-title">{t(`git.title.${props.purpose}`)}</Popover.Title>
          <input
            ref={input}
            class="input branch-search"
            aria-label={t("git.search")}
            placeholder={t("git.search")}
            value={search()}
            onInput={(event) => {
              setSearch(event.currentTarget.value)
              setSelected(0)
            }}
            onKeyDown={navigate}
            aria-controls="branch-options"
            aria-activedescendant={`branch-option-${selected()}`}
          />
          <Show when={reason()}>
            {(why) => (
              <p class="branch-notice" role="status">
                {why()}
              </p>
            )}
          </Show>
          <Show when={failure()}>
            <p class="branch-notice" role="alert">
              {failure()?.message}
            </p>
            <button class="button ghost sm" onClick={() => void refresh()}>
              {t("git.retry")}
            </button>
          </Show>
          <Show when={data()?.loading && !items().length}>
            <p class="subtle branch-notice">{t("git.loading")}</p>
          </Show>
          <div id="branch-options" role="listbox" aria-label={label()} class="branch-options">
            <For each={filtered()}>
              {(item, index) => (
                <div
                  id={`branch-option-${index()}`}
                  role="option"
                  aria-selected={value() === item.name}
                  aria-disabled={disabled(item) || undefined}
                  class="menu-item branch-option"
                  classList={{ focused: selected() === index(), disabled: disabled(item) }}
                  onPointerMove={() => setSelected(index())}
                  onClick={() => void choose(item.name)}
                  title={item.name}
                >
                  <span class="ellipsis grow">{item.name}</span>
                  <span class="subtle">
                    {item.name === current()?.branch
                      ? t("review.currentBranch")
                      : item.worktree && props.purpose === "switch"
                        ? t("git.occupied")
                        : item.name === data()?.options?.defaultBranch
                          ? t("review.defaultBranch")
                          : ""}
                  </span>
                  <Show when={value() === item.name}>
                    <Check class="icon icon-xs" />
                  </Show>
                </div>
              )}
            </For>
          </div>
          <Show when={!data()?.loading && !data()?.error && !filtered().length}>
            <p class="subtle branch-notice">{items().length ? t("git.noMatch") : t("git.empty")}</p>
          </Show>
          <Show when={props.onWorktree && data()?.options?.blocked?.reason === "dirty"}>
            <button
              class="button ghost sm"
              onClick={() => {
                setOpen(false)
                props.onWorktree?.()
              }}
            >
              {t("git.useWorktree")}
            </button>
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
