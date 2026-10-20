import type { BrowserConsole, BrowserState } from "../../desktop/bridge-contract"
import ArrowLeft from "lucide-solid/icons/arrow-left"
import ArrowRight from "lucide-solid/icons/arrow-right"
import Bug from "lucide-solid/icons/bug"
import CircleX from "lucide-solid/icons/circle-x"
import ExternalLink from "lucide-solid/icons/external-link"
import RotateCw from "lucide-solid/icons/rotate-cw"
import TriangleAlert from "lucide-solid/icons/triangle-alert"
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { t } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { overlays } from "../../ui/overlay"
import { toast } from "../../ui/toast"
import { send } from "../conversation/send"

/** Browser state survives switching panel tabs away and back (the page itself stays in the main process too) */
const [page, setPage] = createStore<BrowserState>({
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
})
const [logs, setLogs] = createStore<BrowserConsole[]>([])
bridge?.onBrowserState((state) => setPage(state))
bridge?.onBrowserConsole((entry) => setLogs((list) => [...list.slice(-199), entry]))

/** Completes the typed address to a URL: local hosts without a scheme get http, everything else https */
function normalize(input: string) {
  const value = input.trim()
  if (!value) return ""
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(value)) return `http://${value}`
  return `https://${value}`
}

/**
 * Browser tab: the page is a native view in the main process laid over the viewport element. It moves when the panel
 * resizes and hides when the tab is switched away or an overlay opens.
 */
export function Browser(props: { sessionID?: string; directory: string }) {
  let viewport!: HTMLDivElement
  const [address, setAddress] = createSignal(page.url)
  createEffect(() => setAddress(page.url))

  const place = () => {
    if (!bridge) return
    if (overlays() > 0 || !page.url) return void bridge.browserHide()
    const rect = viewport.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return void bridge.browserHide()
    void bridge.browserShow({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
  }

  onMount(() => {
    const observer = new ResizeObserver(place)
    observer.observe(viewport)
    window.addEventListener("resize", place)
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("resize", place)
      void bridge?.browserHide()
    })
  })
  createEffect(() => {
    overlays()
    page.url
    place()
  })

  const go = () => {
    const url = normalize(address())
    if (!url) return
    if (!bridge) return void toast({ kind: "error", title: t("boot.desktopOnly") })
    void bridge.browserNavigate(url).then(place)
  }

  const errors = () => logs.filter((entry) => entry.level === "error").length
  const sendConsole = () => {
    if (!props.sessionID) return
    const text = logs
      .slice(-40)
      .map((entry) => `[${entry.level}] ${entry.message}${entry.source ? ` (${entry.source}:${entry.line})` : ""}`)
      .join("\n")
    void send(props.sessionID, props.directory, {
      text: `${t("browser.consolePrompt")}\n\n\`\`\`\n${text}\n\`\`\``,
      files: [],
    })
  }

  return (
    <div class="browser">
      <div class="browser-bar">
        <button
          class="icon-button"
          aria-label={t("browser.back")}
          disabled={!page.canGoBack}
          onClick={() => void bridge?.browserBack()}
        >
          <ArrowLeft class="icon icon-sm" />
        </button>
        <button
          class="icon-button"
          aria-label={t("browser.forward")}
          disabled={!page.canGoForward}
          onClick={() => void bridge?.browserForward()}
        >
          <ArrowRight class="icon icon-sm" />
        </button>
        <button
          class="icon-button"
          aria-label={t("browser.reload")}
          disabled={!page.url}
          onClick={() => void bridge?.browserReload()}
        >
          <RotateCw class="icon icon-sm" classList={{ spinner: page.loading }} />
        </button>
        <input
          class="address"
          aria-label={t("browser.address")}
          placeholder={t("browser.addressPlaceholder")}
          value={address()}
          onInput={(event) => setAddress(event.currentTarget.value)}
          onKeyDown={(event) => event.key === "Enter" && go()}
          onFocus={(event) => event.currentTarget.select()}
          spellcheck={false}
        />
        <button
          class="icon-button"
          aria-label={t("browser.devtools")}
          disabled={!page.url}
          onClick={() => void bridge?.browserDevtools()}
        >
          <Bug class="icon icon-sm" />
        </button>
        <button
          class="icon-button"
          aria-label={t("browser.external")}
          disabled={!page.url}
          onClick={() => void bridge?.openExternal(page.url)}
        >
          <ExternalLink class="icon icon-sm" />
        </button>
      </div>
      <Show when={page.title}>
        <div class="browser-title ellipsis" title={page.url}>
          {page.title}
        </div>
      </Show>
      <div class="viewport" ref={viewport}>
        <Show when={!page.url}>
          <div class="empty-state subtle">{t("browser.empty")}</div>
        </Show>
      </div>
      <section class="console" role="region" aria-label={t("browser.console")}>
        <div class="console-head">
          {t("browser.console")}
          <Show when={errors()}>
            <span class="badge danger">{t("browser.errors", { count: errors() })}</span>
          </Show>
          <span class="spacer" />
          <button class="button ghost sm" disabled={!logs.length} onClick={() => setLogs([])}>
            {t("browser.clear")}
          </button>
          <button class="button ghost sm" disabled={!logs.length || !props.sessionID} onClick={sendConsole}>
            {t("browser.sendConsole")}
          </button>
        </div>
        <div class="console-list scroll selectable">
          <For each={logs}>
            {(entry) => (
              <div class={`entry ${entry.level}`}>
                <Show
                  when={entry.level === "error"}
                  fallback={
                    <Show when={entry.level === "warn"}>
                      <TriangleAlert class="icon icon-xs" />
                    </Show>
                  }
                >
                  <CircleX class="icon icon-xs" />
                </Show>
                <span>{entry.message}</span>
              </div>
            )}
          </For>
        </div>
      </section>
    </div>
  )
}
