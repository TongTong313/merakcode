import Pencil from "lucide-solid/icons/pencil"
import Send from "lucide-solid/icons/send"
import Trash2 from "lucide-solid/icons/trash"
import { createMemo, createSignal, For, Show } from "solid-js"
import { produce } from "solid-js/store"
import type { Part } from "@merakcode/sdk/client"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { partsOf, setState, state } from "../../state/store"
import { toast } from "../../ui/toast"

function textOf(messageID: string) {
  return (partsOf(messageID) ?? [])
    .filter((part) => part.type === "text" && "text" in part)
    .map((part) => (part as { text: string }).text)
    .join("")
}

function failed(error: unknown) {
  toast({
    kind: "error",
    title: t("error.request", { message: error instanceof Error ? error.message : String(error) }),
    error,
  })
}

function QueueItem(props: { sessionID: string; directory: string; messageID: string }) {
  const text = createMemo(() => textOf(props.messageID))
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const startEdit = () => {
    setDraft(text())
    setEditing(true)
  }

  const applyQueue = (items: Array<{ messageID: string }>) => {
    setState(
      "sessions",
      "session_queue",
      produce((queue) => {
        if (items.length === 0) delete queue[props.sessionID]
        else queue[props.sessionID] = items
      }),
    )
  }

  const save = async () => {
    const next = draft().trim()
    if (!next || busy()) return
    setBusy(true)
    try {
      const result = await call(
        client(props.directory).session.queueEdit({
          sessionID: props.sessionID,
          messageID: props.messageID,
          text: next,
        }),
      )
      applyQueue(result.items)
      setState(
        "sessions",
        "part",
        props.messageID,
        produce((parts: Part[]) => {
          let replaced = false
          for (const part of parts) {
            if (part.type === "text" && !("synthetic" in part && part.synthetic)) {
              ;(part as { text: string }).text = next
              replaced = true
              break
            }
          }
          if (!replaced) {
            parts.push({
              id: `local-${props.messageID}`,
              sessionID: props.sessionID,
              messageID: props.messageID,
              type: "text",
              text: next,
            } as Part)
          }
        }),
      )
      setEditing(false)
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await call(
        client(props.directory).session.queueRemove({
          sessionID: props.sessionID,
          messageID: props.messageID,
        }),
      )
      applyQueue(result.items)
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }

  const sendNow = async () => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await call(
        client(props.directory).session.queueSendNow({
          sessionID: props.sessionID,
          messageID: props.messageID,
        }),
      )
      applyQueue(result.items)
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="prompt-queue-item" role="listitem" data-message-id={props.messageID}>
      <Show
        when={editing()}
        fallback={
          <>
            <span class="prompt-queue-badge">{t("prompt.queue.badge")}</span>
            <span class="prompt-queue-text ellipsis">{text()}</span>
            <div class="prompt-queue-actions">
              <button
                class="icon-button ghost sm"
                type="button"
                aria-label={t("prompt.queue.sendNow")}
                title={t("prompt.queue.sendNow")}
                disabled={busy()}
                onClick={() => void sendNow()}
              >
                <Send class="icon icon-xs" />
              </button>
              <button
                class="icon-button ghost sm"
                type="button"
                aria-label={t("prompt.queue.edit")}
                title={t("prompt.queue.edit")}
                disabled={busy()}
                onClick={startEdit}
              >
                <Pencil class="icon icon-xs" />
              </button>
              <button
                class="icon-button ghost sm"
                type="button"
                aria-label={t("prompt.queue.remove")}
                title={t("prompt.queue.remove")}
                disabled={busy()}
                onClick={() => void remove()}
              >
                <Trash2 class="icon icon-xs" />
              </button>
            </div>
          </>
        }
      >
        <textarea
          class="prompt-queue-editor"
          value={draft()}
          rows={2}
          aria-label={t("prompt.queue.edit")}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <div class="prompt-queue-actions">
          <button class="button ghost sm" type="button" disabled={busy()} onClick={() => setEditing(false)}>
            {t("common.cancel")}
          </button>
          <button
            class="button secondary sm"
            type="button"
            disabled={busy() || !draft().trim()}
            onClick={() => void save()}
          >
            {t("common.save")}
          </button>
        </div>
      </Show>
    </div>
  )
}

/** Follow-ups waiting while the current turn runs; kept out of the main timeline until they start. */
export function PromptQueue(props: { sessionID: string; directory: string }) {
  const items = createMemo(() => state.sessions.session_queue[props.sessionID] ?? [])
  return (
    <Show when={items().length}>
      <div class="prompt-queue" role="list" aria-label={t("prompt.queue")}>
        <For each={items()}>
          {(item) => <QueueItem sessionID={props.sessionID} directory={props.directory} messageID={item.messageID} />}
        </For>
      </div>
    </Show>
  )
}
