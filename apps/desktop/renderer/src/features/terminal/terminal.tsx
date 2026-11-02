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
  let term: Term | undefined
  let socket: PtyConnection | undefined
  let fit: FitAddon | undefined
  let disposed = false
  const owner = panels()!
  const [error, setError] = createSignal<string>()
  /** Keys typed before the terminal is ready (typing right after opening it) */
  const early: string[] = []

  const earlyKey = (event: KeyboardEvent) => {
    if (term || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key.length === 1) early.push(event.key)
    else if (event.key === "Enter") early.push("\r")
    else if (event.key === "Backspace") early.pop()
    else return
    event.preventDefault()
  }

  // Refit to the current size and take focus when this tab becomes active
  createEffect(() => {
    queueMicrotask(() => {
      fit?.fit()
      if (term) term.focus()
      else host.focus()
    })
  })

  onMount(() => {
    void (async () => {
      const [{ mod, wasm }, { ptyID: id, directory }] = await Promise.all([
        load(),
        terminalFor(props.tab, props.directory, owner, props.sessionID),
      ])
      if (disposed) return
      const c = client(directory)

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
      instance.focus()
    })().catch((error: unknown) => {
      if (!disposed) setError(String(error))
    })
  })

  onCleanup(() => {
    disposed = true
    socket?.close()
    term?.dispose()
  })

  return (
    <section class="terminal-panel" role="region" aria-label={t("terminal.label")}>
      <Show when={error()}>
        <p role="alert">
          {t("panel.terminalEnded")} {error()}
        </p>
      </Show>
      <div
        class="terminal-host"
        ref={host}
        tabIndex={0}
        onKeyDown={earlyKey}
        onClick={() => (term ? term.focus() : host.focus())}
      />
    </section>
  )
}
