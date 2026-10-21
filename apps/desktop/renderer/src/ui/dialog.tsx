import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { Show, type JSX } from "solid-js"
import { trackOverlay } from "./overlay"

/** Dialog whose title is its accessible name; with hideTitle the title is for screen readers only */
export function Dialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  hideTitle?: boolean
  description?: JSX.Element
  children?: JSX.Element
  footer?: JSX.Element
  class?: string
}) {
  trackOverlay(() => props.open)
  return (
    <Kobalte open={props.open} onOpenChange={props.onOpenChange} modal>
      <Kobalte.Portal>
        <Kobalte.Overlay class="dialog-overlay" />
        <div class="dialog-positioner">
          <Kobalte.Content class={`dialog ${props.class ?? ""}`}>
            <div class={props.hideTitle ? "sr-only" : "dialog-head"}>
              <Kobalte.Title class="dialog-title">{props.title}</Kobalte.Title>
            </div>
            <Show when={props.description}>
              <Kobalte.Description class="dialog-desc">{props.description}</Kobalte.Description>
            </Show>
            {props.children}
            <Show when={props.footer}>
              <div class="dialog-foot">{props.footer}</div>
            </Show>
          </Kobalte.Content>
        </div>
      </Kobalte.Portal>
    </Kobalte>
  )
}

/** Confirmation dialog; resolves to whether the user confirmed */
export function Confirm(props: {
  open: boolean
  title: string
  description?: JSX.Element
  confirm: string
  cancel: string
  danger?: boolean
  children?: JSX.Element
  onResult: (ok: boolean) => void
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onResult(false)}
      title={props.title}
      description={props.description}
      footer={
        <>
          <button class="button secondary" onClick={() => props.onResult(false)}>
            {props.cancel}
          </button>
          <button
            class={props.danger ? "button primary danger" : "button primary"}
            onClick={() => props.onResult(true)}
          >
            {props.confirm}
          </button>
        </>
      }
    >
      {props.children}
    </Dialog>
  )
}
