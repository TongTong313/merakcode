import type { FitAddon, Terminal as Term } from "ghostty-web"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { connectTerminal, type TerminalConnection } from "@merakcode/sdk"
import { t } from "../../i18n"
import { log } from "../../lib/bridge"
import { client } from "../../state/client"
import { codeOf, MerakCodeError, summary } from "../../state/error"
import { copyDetails } from "../../ui/toast"
import { panels } from "../panel/workspace"
import type { PanelTab } from "../panel/state"
import { sendTerminalInput, terminalFor } from "./resource"

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

const asError = (error: unknown) =>
  error instanceof MerakCodeError
    ? error
    : new MerakCodeError({
        code: codeOf(error) ?? "MRK-4028",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      })

/** The shell in one tab: attaches to (or creates) a terminal process, shows its output and forwards keys */
export function Terminal(props: { directory: string; tab: PanelTab; sessionID?: string }) {
  let host!: HTMLDivElement
  let viewport!: HTMLDivElement
  let input!: HTMLTextAreaElement
  let term: Term | undefined
  let socket: TerminalConnection | undefined
  let fit: FitAddon | undefined
  let composition: ReturnType<typeof Promise.withResolvers<void>> | undefined
  let disposed = false
  let starting = false
  const owner = panels()!
  const [error, setError] = createSignal<MerakCodeError>()
  const [ready, setReady] = createSignal(false)
  const ended = () => !!props.tab.view?.ended
  const detach = () => {
    const previous = socket
    socket = undefined
    previous?.close()
    term?.dispose()
    term = undefined
    fit = undefined
  }
  const send = (data: string) => {
    void sendTerminalInput(props.tab.id, data).catch((error: unknown) => {
      if (!disposed) setError(asError(error))
      else log("warn", "terminal input failed")
    })
  }
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
    send(`${input.value}\r`)
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
    if (starting || disposed || ended()) return
    starting = true
    detach()
    setReady(false)
    setError(undefined)
    void (async () => {
      const [{ mod, wasm }, address] = await Promise.all([
        load(),
        terminalFor(props.tab, props.directory, owner, props.sessionID),
      ])
      await composition?.promise
      if (disposed || ended() || !address) return
      const { ptyID: id } = address
      const c = await client()
      const focused = viewport.contains(document.activeElement)
      send(input.value)
      input.value = ""

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

      const decoder = new TextDecoder()
      const connection = connectTerminal({
        endpoint: location.origin,
        id,
        cursor: 0,
        onData(data) {
          if (!disposed && !ended()) instance.write(decoder.decode(data, { stream: true }))
        },
        onError() {
          log("warn", "terminal socket error")
        },
        onClose() {
          if (disposed || ended() || socket !== connection) return
          setError(new MerakCodeError({ code: "MRK-4028", message: t("terminal.connectionClosed") }))
        },
        onOpen() {
          void c.terminal.update({ id, size: { cols: instance.cols, rows: instance.rows } }).catch(() => {})
        },
      })
      socket = connection
      instance.onData(send)
      instance.onResize(({ cols, rows }) => void c.terminal.update({ id, size: { cols, rows } }).catch(() => {}))
      term = instance
      setReady(true)
      if (focused) instance.focus()
    })()
      .catch((error: unknown) => {
        if (!disposed) setError(asError(error))
      })
      .finally(() => {
        starting = false
      })
  }
  onMount(start)

  onCleanup(() => {
    disposed = true
    if (!ready() && input) {
      send(input.value)
      input.value = ""
    }
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
          {error()?.message}
          <span class="mono"> {summary(error())}</span>
          <button class="button secondary" onClick={() => void copyDetails(error())}>
            {t("error.copyDetails")}
          </button>
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
