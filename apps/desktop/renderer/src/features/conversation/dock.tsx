import type { PermissionRequest, QuestionRequest } from "@merakcode/sdk/client"
import {
  permissionChoices,
  permissionKind,
  permissionTags,
  type PermissionChoice,
} from "@merakcode/client-core/permission"
import MessageCircleQuestion from "lucide-solid/icons/message-circle-question-mark"
import ShieldAlert from "lucide-solid/icons/shield-alert"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { t, type Key } from "../../i18n"
import { relative } from "../../lib/route"
import { call, client } from "../../state/client"
import { session } from "../../state/store"
import { toast } from "../../ui/toast"

const directoryOf = (sessionID: string, fallback: string) => session(sessionID)?.directory ?? fallback

/** Permission request title: what the agent wants to do */
function title(request: PermissionRequest) {
  const kind = permissionKind(request.permission)
  if (kind === "tool") return t("approval.tool", { name: request.permission })
  return t(`approval.${kind}` as Key)
}

/** Permission request subject: a command, file, URL and so on */
function subject(request: PermissionRequest, directory: string) {
  const meta = request.metadata ?? {}
  if (typeof meta.command === "string") return meta.command
  if (typeof meta.filepath === "string") return relative(directory, meta.filepath)
  if (typeof meta.url === "string") return meta.url
  return request.patterns.join("\n")
}

/** The agent asks for permission; options can also be picked with number keys */
export function Approval(props: { request: PermissionRequest; more: number; directory: string }) {
  const [reason, setReason] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const choices = () => permissionChoices(props.request)
  const label = (choice: PermissionChoice) => t(choice.label.key as Key, choice.label.vars)

  const reply = async (choice: PermissionChoice, message?: string) => {
    if (busy()) return
    setBusy(true)
    await call(
      client(directoryOf(props.request.sessionID, props.directory)).permission.reply({
        requestID: props.request.id,
        reply: choice.reply,
        ...(choice.scope ? { scope: choice.scope } : {}),
        ...(message ? { message } : {}),
      }),
    )
      .catch((error: Error) =>
        toast({ kind: "error", title: t("error.request", { message: error.message }), error: error }),
      )
      .finally(() => setBusy(false))
  }

  onMount(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest("input, textarea, [contenteditable]") || event.ctrlKey || event.metaKey || event.altKey) return
      const index = Number(event.key) - 1
      const choice = choices()[index]
      if (!choice || !/^[1-9]$/.test(event.key)) return
      event.preventDefault()
      void reply(choice)
    }
    window.addEventListener("keydown", listener)
    onCleanup(() => window.removeEventListener("keydown", listener))
  })

  return (
    <section class="approval" role="region" aria-label={t("approval.label")}>
      <div class="approval-head">
        <ShieldAlert class="icon" />
        <span class="what">{title(props.request)}</span>
        <For each={permissionTags(props.request)}>
          {(tag) => <span class="badge warning">{t(`approval.tag.${tag}` as Key)}</span>}
        </For>
        <span class="spacer" />
        <Show when={props.more}>
          <span class="subtle">{t("approval.more", { count: props.more })}</span>
        </Show>
      </div>
      <pre class="command selectable">{subject(props.request, props.directory)}</pre>
      <Show
        when={reason() === undefined}
        fallback={
          <div class="approval-reason">
            <textarea
              class="input"
              aria-label={t("approval.reason")}
              placeholder={t("approval.reasonPlaceholder")}
              value={reason()}
              onInput={(event) => setReason(event.currentTarget.value)}
              autofocus
            />
            <div class="row">
              <span class="spacer" />
              <button class="button ghost sm" onClick={() => setReason(undefined)}>
                {t("common.cancel")}
              </button>
              <button
                class="button primary sm"
                disabled={busy()}
                onClick={() => void reply(choices().at(-1)!, reason()?.trim() || undefined)}
              >
                {t("permission.option.reject")}
              </button>
            </div>
          </div>
        }
      >
        <div class="approval-actions">
          <For each={choices()}>
            {(choice, index) => (
              <button
                class={index() === 0 ? "button primary sm" : "button secondary sm"}
                disabled={busy()}
                onClick={() => void reply(choice)}
              >
                <kbd aria-hidden="true">{index() + 1}</kbd>
                <span>{label(choice)}</span>
              </button>
            )}
          </For>
          <button class="button ghost sm" onClick={() => setReason("")}>
            {t("approval.rejectWithReason")}
          </button>
        </div>
      </Show>
    </section>
  )
}

/**
 * The agent asks a question. With one single-choice question, clicking an option submits; multiple choice or several
 * questions need a final Submit.
 */
export function Question(props: { request: QuestionRequest; directory: string }) {
  const [answers, setAnswers] = createSignal<string[][]>(props.request.questions.map(() => []))
  const [custom, setCustom] = createSignal<string[]>(props.request.questions.map(() => ""))
  const [busy, setBusy] = createSignal(false)
  const quick = () => props.request.questions.length === 1 && !props.request.questions[0]!.multiple
  const dir = () => directoryOf(props.request.sessionID, props.directory)

  const submit = async (values = answers()) => {
    setBusy(true)
    const final = values.map((list, index) => (custom()[index]?.trim() ? [...list, custom()[index]!.trim()] : list))
    await call(client(dir()).question.reply({ requestID: props.request.id, answers: final }))
      .catch((error: Error) =>
        toast({ kind: "error", title: t("error.request", { message: error.message }), error: error }),
      )
      .finally(() => setBusy(false))
  }
  const toggle = (index: number, label: string, multiple: boolean) => {
    const next = answers().map((list, i) =>
      i !== index
        ? list
        : multiple
          ? list.includes(label)
            ? list.filter((item) => item !== label)
            : [...list, label]
          : [label],
    )
    setAnswers(next)
    if (quick()) void submit(next)
  }
  const skip = () =>
    call(client(dir()).question.reject({ requestID: props.request.id })).catch((error: Error) =>
      toast({ kind: "error", title: t("error.request", { message: error.message }), error: error }),
    )

  return (
    <section class="approval question" role="region" aria-label={t("question.label")}>
      <For each={props.request.questions}>
        {(question, index) => (
          <div class="question-item">
            <div class="approval-head">
              <MessageCircleQuestion class="icon" />
              <span class="what selectable">{question.question}</span>
            </div>
            <div class="question-options">
              <For each={question.options}>
                {(option) => (
                  <button
                    class="question-option"
                    aria-pressed={answers()[index()]?.includes(option.label) ?? false}
                    disabled={busy()}
                    onClick={() => toggle(index(), option.label, !!question.multiple)}
                  >
                    <span class="label">{option.label}</span>
                    <Show when={option.description}>
                      <span class="desc">{option.description}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
            <Show when={question.custom !== false}>
              <input
                class="input"
                aria-label={t("question.other")}
                placeholder={t("question.otherPlaceholder")}
                value={custom()[index()]}
                onInput={(event) =>
                  setCustom((list) => list.map((item, i) => (i === index() ? event.currentTarget.value : item)))
                }
                onKeyDown={(event) => event.key === "Enter" && !event.isComposing && void submit()}
              />
            </Show>
          </div>
        )}
      </For>
      <div class="approval-actions">
        <span class="spacer" />
        <Show when={props.request.questions.every((question) => question.dismiss !== false)}>
          <button class="button ghost sm" onClick={() => void skip()}>
            {t("question.skip")}
          </button>
        </Show>
        <Show when={!quick() || custom()[0]?.trim()}>
          <button class="button primary sm" disabled={busy()} onClick={() => void submit()}>
            {t("question.submit")}
          </button>
        </Show>
      </div>
    </section>
  )
}
