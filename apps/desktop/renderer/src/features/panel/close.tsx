import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useLocation } from "@solidjs/router"
import { fromError, summary } from "../../state/error"
import { copyDetails } from "../../ui/toast"
import { bridge } from "../../lib/bridge"
import { t } from "../../i18n"
import { Dialog } from "../../ui/dialog"
import { flushDrafts } from "../code/draft"
import { stopAllTerminals } from "../terminal/resource"
import { flushPanels, panels } from "./workspace"

/** A native close waits for drafts and terminal shutdown, including application quit. */
export function CloseEditor() {
  const location = useLocation()
  const [requested, setRequested] = createSignal(false)
  const [working, setWorking] = createSignal(false)
  let stage: "draft" | "terminal" = "draft"
  const [error, setError] = createSignal<string>()
  const [failure, setFailure] = createSignal<unknown>()
  createEffect(() => {
    location.pathname
    void bridge?.installCloseGuard()
  })
  const persist = async () => {
    stage = "draft"
    window.dispatchEvent(new Event("merakcode:flush-editor"))
    await flushDrafts()
    await flushPanels()
  }
  const finish = async () => {
    if (working()) return
    setWorking(true)
    setError(undefined)
    setFailure(undefined)
    try {
      await persist()
      setRequested(false)
      setWorking(false)
      const accepted = await bridge?.completeClose(true)
      if (accepted === false) {
        setError(t("browser.closeBlocked"))
        setRequested(true)
      }
    } catch (error) {
      setFailure(fromError(error))
      setError(stage === "draft" ? t("panel.persistError") : String(error))
      setRequested(true)
    } finally {
      setWorking(false)
    }
  }
  const cancel = () => {
    if (working()) return
    setRequested(false)
    void bridge?.completeClose(false)
  }
  onMount(() => {
    const blockInput = (event: KeyboardEvent) => {
      if (!document.documentElement.inert) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener("keydown", blockInput, true)
    onCleanup(() => window.removeEventListener("keydown", blockInput, true))
    onCleanup(
      bridge?.onCloseCancelled(() => {
        document.documentElement.inert = false
        setWorking(false)
      }) ?? (() => {}),
    )
    onCleanup(
      bridge?.onCloseRejected(() => {
        setFailure(undefined)
        setError(t("browser.closeBlocked"))
        setRequested(true)
      }) ?? (() => {}),
    )
    onCleanup(
      bridge?.onCloseResources((phase) => {
        setWorking(true)
        document.documentElement.inert = true
        void (async () => {
          await persist()
          if (phase === "stop") {
            stage = "terminal"
            await stopAllTerminals()
            await persist()
          }
          await bridge?.completeResourceClose(true)
        })()
          .catch(async (error: unknown) => {
            setFailure(fromError(error))
            document.documentElement.inert = false
            setError(stage === "draft" ? t("panel.persistError") : String(error))
            setRequested(true)
            setWorking(false)
            await bridge?.completeResourceClose(false)
          })
          .finally(() => phase === "stop" && setWorking(false))
      }) ?? (() => {}),
    )
    onCleanup(
      bridge?.onCloseRequested(() => {
        window.dispatchEvent(new Event("merakcode:flush-editor"))
        const commitDraft = document
          .querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t("review.commitMessage")}"]`)
          ?.value.trim()
        const unsaved =
          !!commitDraft ||
          panels()?.state.tabs.some(
            (tab) =>
              tab.view?.dirty ||
              (typeof tab.view?.commit === "string" && tab.view.commit.trim()) ||
              (Array.isArray(tab.view?.commitAlternatives) && tab.view.commitAlternatives.length > 0) ||
              (tab.kind === "review" && JSON.stringify(tab.view?.drafts ?? {}) !== "{}"),
          )
        if (unsaved) setRequested(true)
        else void finish()
      }) ?? (() => {}),
    )
    void bridge?.installCloseGuard()
  })
  return (
    <Dialog
      open={requested()}
      title={t("panel.closeWindow")}
      description={t("panel.closeWindowDetail")}
      onOpenChange={(open) => !open && cancel()}
      footer={
        <>
          <button class="button secondary" disabled={working()} onClick={cancel}>
            {t("common.cancel")}
          </button>
          <button class="button primary" disabled={working()} onClick={() => void finish()}>
            {t("panel.keepDraftsClose")}
          </button>
        </>
      }
    >
      <Show when={error()}>
        <p role="alert">{error()}</p>
        <Show when={summary(failure())}>
          {(line) => (
            <>
              <p class="mono">{line()}</p>
              <button class="button secondary" onClick={() => void copyDetails(failure())}>
                {t("error.copyDetails")}
              </button>
            </>
          )}
        </Show>
      </Show>
    </Dialog>
  )
}
