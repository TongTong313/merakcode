import type { EngineEvent } from "@merakcode/sdk"
import MessageCircleQuestion from "lucide-solid/icons/message-circle-question-mark"
import ShieldAlert from "lucide-solid/icons/shield-alert"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { toast } from "../../ui/toast"

const failed = (error: unknown) =>
  toast({
    kind: "error",
    title: t("error.request", { message: error instanceof Error ? error.message : "MRK-1001" }),
    error,
  })

export function Approval(props: {
  request: Extract<EngineEvent, { type: "permission.requested" }>
  more?: number
  human?: string
}) {
  const [busy, setBusy] = createSignal(false)
  const reply = async (decision: "allow" | "deny") => {
    const request = props.request.id
    setBusy(true)
    try {
      await (await client()).permission.reply({ request, decision, human: props.human })
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section class="approval" role="region" aria-label={t("approval.label")}>
      <div class="approval-head">
        <ShieldAlert class="icon" />
        <span class="what">{t("approval.tool", { name: props.request.payload.call.name })}</span>
        <span class="spacer" />
        <Show when={props.more}>
          <span class="subtle">{t("approval.more", { count: props.more! })}</span>
        </Show>
      </div>
      <pre class="command selectable">{JSON.stringify(props.request.payload.call.input, null, 2)}</pre>
      <div class="approval-actions">
        <button class="button primary sm" disabled={busy()} onClick={() => void reply("allow")}>
          {t("permission.option.once")}
        </button>
        <button class="button secondary sm" disabled={busy()} onClick={() => void reply("deny")}>
          {t("permission.option.reject")}
        </button>
      </div>
    </section>
  )
}

export function Question(props: { request: Extract<EngineEvent, { type: "question.asked" }>; human?: string }) {
  const [answer, setAnswer] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  createEffect(
    on(
      () => props.request.id,
      () => {
        setAnswer("")
        setBusy(false)
      },
      { defer: true },
    ),
  )
  const reply = async (cancelled = false) => {
    const request = props.request.id
    const text = answer().trim()
    if (busy() || (!cancelled && !text)) return
    setBusy(true)
    try {
      await (await client()).question.reply({ request, text, cancelled, human: props.human })
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section class="approval question" role="region" aria-label={t("question.label")}>
      <div class="question-item">
        <div class="approval-head">
          <MessageCircleQuestion class="icon" />
          <span class="what selectable">{props.request.payload.text}</span>
        </div>
        <div class="question-options">
          <For each={props.request.payload.options ?? []}>
            {(option) => (
              <button
                class="question-option"
                aria-pressed={answer() === option}
                disabled={busy()}
                onClick={() => setAnswer(option)}
              >
                <span class="label">{option}</span>
              </button>
            )}
          </For>
        </div>
        <input
          class="input"
          aria-label={t("question.other")}
          placeholder={t("question.otherPlaceholder")}
          value={answer()}
          onInput={(event) => setAnswer(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) void reply()
          }}
        />
      </div>
      <div class="approval-actions">
        <span class="spacer" />
        <button class="button ghost sm" disabled={busy()} onClick={() => void reply(true)}>
          {t("question.skip")}
        </button>
        <button class="button primary sm" disabled={busy() || !answer().trim()} onClick={() => void reply()}>
          {t("question.submit")}
        </button>
      </div>
    </section>
  )
}
