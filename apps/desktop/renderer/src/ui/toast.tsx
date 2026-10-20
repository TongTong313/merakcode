import CircleCheck from "lucide-solid/icons/circle-check"
import CircleAlert from "lucide-solid/icons/circle-alert"
import Copy from "lucide-solid/icons/copy"
import Info from "lucide-solid/icons/info"
import X from "lucide-solid/icons/x"
import { For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { t } from "../i18n"
import { bridge } from "../lib/bridge"
import { details, summary } from "../state/error"

type Toast = {
  id: number
  kind: "info" | "success" | "error"
  title: string
  detail?: string
  /** The failure behind an error toast: shows its code and offers "Copy details" */
  error?: unknown
  action?: { label: string; run: () => void }
}

const [toasts, setToasts] = createStore<Toast[]>([])
let next = 1

/** Toasts in the bottom-right corner; they dismiss themselves after a few seconds (errors stay longer) */
export function toast(input: Omit<Toast, "id">) {
  const id = next++
  setToasts((list) => [...list.slice(-3), { ...input, id }])
  setTimeout(() => dismiss(id), input.kind === "error" ? 8000 : 4000)
  return id
}

const dismiss = (id: number) => setToasts((list) => list.filter((item) => item.id !== id))

/** Copies the error's code, message, request id and app version, ready to paste into a bug report */
export function copyDetails(error: unknown) {
  const text = details(error, {
    version: bridge?.version ?? "dev",
    platform: bridge?.os ?? navigator.platform,
    time: new Date().toISOString(),
  })
  return (bridge ? bridge.writeClipboardText(text) : navigator.clipboard.writeText(text)).then(
    () => void toast({ kind: "success", title: t("common.copied") }),
    (error: Error) => void toast({ kind: "error", title: t("error.request", { message: error.message }) }),
  )
}

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      <For each={toasts}>
        {(item) => (
          <div class={`toast ${item.kind}`}>
            <Switch fallback={<Info class="icon" />}>
              <Match when={item.kind === "success"}>
                <CircleCheck class="icon" />
              </Match>
              <Match when={item.kind === "error"}>
                <CircleAlert class="icon" />
              </Match>
            </Switch>
            <div class="body selectable">
              <div class="title">{item.title}</div>
              <Show when={item.detail}>
                <div class="muted">{item.detail}</div>
              </Show>
              <Show when={summary(item.error)}>{(line) => <div class="muted mono">{line()}</div>}</Show>
            </div>
            <Show when={item.action}>
              {(action) => (
                <button
                  class="button sm secondary"
                  onClick={() => {
                    action().run()
                    dismiss(item.id)
                  }}
                >
                  {action().label}
                </button>
              )}
            </Show>
            <Show when={summary(item.error)}>
              <button
                class="icon-button sm"
                aria-label={t("error.copyDetails")}
                title={t("error.copyDetails")}
                onClick={() => void copyDetails(item.error)}
              >
                <Copy class="icon icon-sm" />
              </button>
            </Show>
            <button class="icon-button sm" aria-label={t("common.close")} onClick={() => dismiss(item.id)}>
              <X class="icon icon-sm" />
            </button>
          </div>
        )}
      </For>
    </div>
  )
}
