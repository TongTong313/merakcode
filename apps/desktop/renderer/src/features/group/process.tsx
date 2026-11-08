import { createResource, createSignal, Show } from "solid-js"
import { t } from "../../i18n"
import { ensureSession } from "../../state/store"
import { Messages } from "../conversation/messages"

export function ClaimProcess(props: { session: string; directory: string }) {
  const [open, setOpen] = createSignal(false)
  const [loaded, { refetch }] = createResource(() => open() && props.session, ensureSession)
  return (
    <details class="claim-process" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t("task.process")}</summary>
      <Show when={open()}>
        <Show
          when={!loaded.error}
          fallback={
            <button class="button secondary" onClick={() => void refetch()}>
              {t("error.retry")}
            </button>
          }
        >
          <Show when={loaded.state === "ready"} fallback={<p role="status">{t("task.processLoading")}</p>}>
            <Messages sessionID={props.session} directory={loaded()?.directory ?? props.directory} />
          </Show>
        </Show>
      </Show>
    </details>
  )
}
