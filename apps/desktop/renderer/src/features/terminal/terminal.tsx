import type { FitAddon, Terminal as Term } from "ghostty-web"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { connectPty, type PtyConnection } from "@merakcode/sdk/client"
import { t } from "../../i18n"
import { log } from "../../lib/bridge"
import { client } from "../../state/client"
import { panels } from "../panel/workspace"
import type { PanelTab } from "../panel/state"
import { terminalFor } from "./resource"

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
export function Terminal(props: { directory: string; tab: PanelTab; sessionID?: string }) {
  let host!: HTMLDivElement
  let viewport!: HTMLDivElement
  let input!: HTMLTextAreaElement
  let term: Term | undefined
  let socket: PtyConnection | undefined
  let fit: FitAddon | undefined
  let composition: ReturnType<typeof Promise.withResolvers<void>> | undefined
  let disposed = false
  const owner = panels()!
  const [error, setError] = createSignal<string>()
  const [ready, setReady] = createSignal(false)
  const ended = () => !!props.tab.view?.ended
  const detach = () => {
    socket?.close()
    socket = undefined
    term?.dispose()
    term = undefined
    fit = undefined
  }
  /** Keys typed before the terminal is ready (typing right after opening it) */
  const early: string[] = []
  const finishComposition = () => {
    composition?.resolve()
    composition = undefined
  }
  createEffect(() => {
    if (!ended()) return
    finishComposition()
    detach()
  })

  const earlyKey = (event: KeyboardEvent) => {
    if (event.isComposing || event.key !== "Enter") return
    early.push(input.value, "\r")
    input.value = ""
    event.preventDefault()
  }

  // Refit to the current size and take focus when this tab becomes active
  createEffect(() => {
    queueMicrotask(() => {
      fit?.fit()
      if (term) term.focus()
      else input?.focus()
    })
  })

  const start = () => {
    setError(undefined)
    void (async () => {
      const [{ mod, wasm }, address] = await Promise.all([
        load(),
        terminalFor(props.tab, props.directory, owner, props.sessionID),
      ])
      await composition?.promise
      if (disposed || ended() || !address) return
      const { ptyID: id, directory } = address
      const c = client(directory)
      const focused = viewport.contains(document.activeElement)
      early.push(input.value)

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
      // Ghostty schedules focus while opening; let the caller choose focus after initialization instead.
      const focus = instance.focus
      instance.focus = () => {}
      try {
        instance.open(host)
      } finally {
        instance.focus = focus
      }
      fit.fit()
      fit.observeResize?.()

      const connection = connectPty({
        baseUrl: location.origin,
        ptyID: id,
        directory,
        cursor: 0,
        onData(data) {
          // Binary frames starting with 0x00 carry control data (the output position) and are not displayed
          if (typeof data === "string") instance.write(data)
        },
        onError() {
          log("warn", "terminal socket error")
        },
        onOpen() {
          void c.pty.update({ ptyID: id, size: { cols: instance.cols, rows: instance.rows } })
        },
      })
      socket = connection
      for (const data of early.splice(0)) connection.send(data)
      instance.onData((data) => connection.send(data))
      instance.onResize(({ cols, rows }) => void c.pty.update({ ptyID: id, size: { cols, rows } }))
      term = instance
      setReady(true)
      if (focused) instance.focus()
    })().catch((error: unknown) => {
      if (!disposed) setError(String(error))
    })
  }
  onMount(start)

  onCleanup(() => {
    disposed = true
    finishComposition()
    detach()
  })

  return (
    <section class="terminal-panel" role="region" aria-label={t("terminal.label")}>
      <Show when={ended()}>
        <p role="status">{t("panel.terminalEnded")}</p>
      </Show>
      <Show when={error() && !ended()}>
        <p role="alert">
          {error()}
          <button class="button secondary" onClick={start}>
            {t("panel.retry")}
          </button>
        </p>
      </Show>
      <div class="terminal-host" ref={viewport} onClick={() => (term ? term.focus() : input?.focus())}>
        <div class="terminal-surface" ref={host} />
        <Show when={!ready() && !ended()}>
          <textarea
            ref={input}
            class="terminal-startup-input"
            aria-label={t("terminal.input")}
            spellcheck={false}
            onKeyDown={earlyKey}
            onCompositionStart={() => (composition ??= Promise.withResolvers<void>())}
            onCompositionEnd={finishComposition}
          />
        </Show>
      </div>
    </section>
  )
}
