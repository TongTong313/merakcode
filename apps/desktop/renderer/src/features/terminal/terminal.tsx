import type { FitAddon, Terminal as Term } from "ghostty-web"
import Plus from "lucide-solid/icons/plus"
import X from "lucide-solid/icons/x"
import { createEffect, For, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { connectTerminal, type TerminalConnection } from "@merakcode/sdk"
import { t } from "../../i18n"
import { log } from "../../lib/bridge"
import { client } from "../../state/client"
import { toast } from "../../ui/toast"
import { saveLayout, setUi, ui } from "../../state/ui"

/**
 * One group of terminal tabs per directory, one shell process per tab. Collapsing the terminal area keeps the
 * processes alive and reopening resumes them (the server replays the output); only closing a tab ends its process.
 */
type Tab = { key: number; terminalID?: string }
const [groups, setGroups] = createStore<Record<string, { tabs: Tab[]; active: number; next: number }>>({})

const starting = new Map<string, Promise<string | undefined>>()

function prepare(directory: string, tab: Tab) {
  const key = `${directory}\0${tab.key}`
  const existing = starting.get(key)
  if (existing) return existing
  const pending = (async () => {
    const connection = await client()
    if (tab.terminalID) {
      try {
        return (await connection.terminal.get({ id: tab.terminalID })).id
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "MRK-5001") throw error
      }
    }
    if (!groups[directory]?.tabs.some((item) => item.key === tab.key)) return
    const created = await connection.terminal.create({ directory, size: { cols: 80, rows: 24 } })
    if (!groups[directory]?.tabs.some((item) => item.key === tab.key)) {
      await connection.terminal.remove({ id: created.id })
      return
    }
    setGroups(directory, "tabs", (item) => item.key === tab.key, "terminalID", created.id)
    return created.id
  })().finally(() => starting.delete(key))
  starting.set(key, pending)
  return pending
}

function add(directory: string) {
  const group = groups[directory]
  const key = group?.next ?? 1
  setGroups(directory, (current) => ({
    tabs: [...(current?.tabs ?? []), { key }],
    active: key,
    next: key + 1,
  }))
}

/**
 * Load the ghostty wasm from the app root. Without a path it first tries an inline data: URL, which CSP blocks, then
 * a path relative to the current page, which does not exist.
 */
let ghostty: Promise<{ mod: typeof import("ghostty-web"); wasm: import("ghostty-web").Ghostty }> | undefined
const load = () =>
  (ghostty ??= import("ghostty-web").then(async (mod) => ({ mod, wasm: await mod.Ghostty.load("/ghostty-vt.wasm") })))

/** Terminal colors, matching tokens.css; written out here because minified CSS variables use shorthand values */
const colors = () =>
  matchMedia("(prefers-color-scheme: dark)").matches
    ? { background: "#131315", foreground: "#ededef", cursor: "#6366f1", selectionBackground: "#3730a3" }
    : { background: "#ffffff", foreground: "#18181b", cursor: "#4f46e5", selectionBackground: "#c7d2fe" }

/** The shell in one tab: attaches to (or creates) a terminal process, shows its output and forwards keys */
function Shell(props: { directory: string; tab: Tab; active: boolean }) {
  let host!: HTMLDivElement
  let term: Term | undefined
  let socket: TerminalConnection | undefined
  let fit: FitAddon | undefined
  let disposed = false
  /** Keys typed before the terminal is ready (typing right after opening it) */
  const early: string[] = []

  const earlyKey = (event: KeyboardEvent) => {
    if ((term && event.target !== host) || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    const data =
      event.key.length === 1 ? event.key : event.key === "Enter" ? "\r" : event.key === "Backspace" ? "\x7f" : undefined
    if (!data) return
    if (socket) socket.send(data)
    else if (event.key === "Backspace") early.pop()
    else early.push(data)
    event.preventDefault()
  }

  // Refit to the current size and take focus when this tab becomes active
  createEffect(() => {
    if (!props.active) return
    queueMicrotask(() => {
      fit?.fit()
      if (term) term.focus()
      else host.focus()
    })
  })

  const start = async () => {
    const c = await client()
    if (disposed) return
    const [{ mod, wasm }, id] = await Promise.all([load(), prepare(props.directory, props.tab)])
    if (disposed || !id) return

    const instance = new mod.Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 12,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
      theme: colors(),
      scrollback: 10_000,
      ghostty: wasm,
    })
    fit = new mod.FitAddon()
    instance.loadAddon(fit)
    instance.open(host)
    fit.fit()
    fit.observeResize?.()

    const decoder = new TextDecoder()
    const connection = connectTerminal({
      endpoint: location.origin,
      id,
      cursor: 0,
      onData(data) {
        instance.write(decoder.decode(data, { stream: true }))
      },
      onError() {
        log("warn", "terminal socket error")
      },
      onOpen() {
        void c.terminal.update({ id, size: { cols: instance.cols, rows: instance.rows } }).catch(failed)
      },
    })
    socket = connection
    for (const data of early.splice(0)) connection.send(data)
    instance.onData((data) => connection.send(data))
    instance.onResize(({ cols, rows }) => void c.terminal.update({ id, size: { cols, rows } }).catch(failed))
    term = instance
    if (props.active) instance.focus()
  }
  const failed = (error: unknown) => {
    if (!disposed) toast({ kind: "error", title: t("terminal.label"), error })
  }
  onMount(() => {
    void start().catch(failed)
  })

  onCleanup(() => {
    disposed = true
    socket?.close()
    term?.dispose()
  })

  return (
    <div
      class="terminal-host"
      classList={{ hidden: !props.active }}
      ref={host}
      tabIndex={0}
      onKeyDown={earlyKey}
      onClick={() => (term ? term.focus() : host.focus())}
    />
  )
}

/** Bottom terminal area: tabs for several shells, all in the conversation's directory */
export function Terminal(props: { directory: string }) {
  const group = () => groups[props.directory]
  onMount(() => {
    if (!group()?.tabs.length) add(props.directory)
  })

  const close = (tab: Tab) => {
    if (tab.terminalID)
      void client()
        .then((c) => c.terminal.remove({ id: tab.terminalID! }))
        .catch(() => {})
    setGroups(
      props.directory,
      produce((draft) => {
        const index = draft.tabs.findIndex((item) => item.key === tab.key)
        draft.tabs.splice(index, 1)
        if (draft.active === tab.key) draft.active = (draft.tabs[index] ?? draft.tabs[index - 1])?.key ?? 0
      }),
    )
    if (!group()?.tabs.length) setUi("terminal", false)
  }

  const resize = (event: PointerEvent) => {
    const start = event.clientY
    const height = ui.terminalHeight
    const move = (next: PointerEvent) =>
      setUi("terminalHeight", Math.min(Math.max(120, height + start - next.clientY), window.innerHeight - 240))
    const up = () => {
      window.removeEventListener("pointermove", move)
      saveLayout()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up, { once: true })
  }

  return (
    <section
      class="terminal"
      role="region"
      aria-label={t("terminal.label")}
      style={{ height: `${ui.terminalHeight}px` }}
    >
      <div class="terminal-resize" onPointerDown={resize} />
      <div class="terminal-head">
        <div class="terminal-tabs" role="tablist" aria-label={t("terminal.label")}>
          <For each={group()?.tabs ?? []}>
            {(tab) => (
              <div
                class="terminal-tab"
                role="tab"
                aria-selected={group()?.active === tab.key}
                tabIndex={group()?.active === tab.key ? 0 : -1}
                onClick={() => setGroups(props.directory, "active", tab.key)}
              >
                <span>{t("terminal.tab", { n: tab.key })}</span>
                <button
                  class="icon-button sm"
                  aria-label={t("terminal.closeTab", { n: tab.key })}
                  onClick={(event) => {
                    event.stopPropagation()
                    close(tab)
                  }}
                >
                  <X class="icon icon-xs" />
                </button>
              </div>
            )}
          </For>
          <button
            class="icon-button sm"
            aria-label={t("terminal.new")}
            title={t("terminal.new")}
            onClick={() => add(props.directory)}
          >
            <Plus class="icon icon-sm" />
          </button>
        </div>
        <span class="subtle mono ellipsis">{props.directory}</span>
        <span class="spacer" />
        <button class="icon-button sm" aria-label={t("terminal.close")} onClick={() => setUi("terminal", false)}>
          <X class="icon icon-sm" />
        </button>
      </div>
      <div class="terminal-body">
        <For each={group()?.tabs ?? []}>
          {(tab) => <Shell directory={props.directory} tab={tab} active={group()?.active === tab.key} />}
        </For>
      </div>
    </section>
  )
}
