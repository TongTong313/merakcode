import ArrowUp from "lucide-solid/icons/arrow-up"
import Brain from "lucide-solid/icons/brain"
import Paperclip from "lucide-solid/icons/paperclip"
import Square from "lucide-solid/icons/square"
import X from "lucide-solid/icons/x"
import { createEffect, createSignal, For, on, onMount, Show } from "solid-js"
import { t } from "../../i18n"
import { choice, choiceKey, choose, find, usage } from "../../state/models"
import { connected } from "../../state/store"
import { Select } from "../../ui/select"
import { toast } from "../../ui/toast"
import { AttachmentPreview } from "./attachment"
import { ModelPicker } from "./model-picker"
import { SandboxStatus } from "./sandbox-status"

export type Attachment = { filename: string; mime: string; url: string }
export type Submission = { text: string; files: Attachment[] }
export type ComposerDraft = Submission
const attachmentBytes = (url: string) => {
  const data = url.slice(url.indexOf(",") + 1)
  return (data.length * 3) / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
}

export function Composer(props: {
  group?: boolean
  sessionID?: string
  directory: string
  busy: boolean
  disabled?: boolean
  draft?: ComposerDraft
  onDraftChange?: (draft: ComposerDraft) => void
  compact?: boolean
  autofocus?: boolean
  placeholder?: string
  onSubmit: (submission: Submission) => Promise<unknown> | void
  onStop?: () => void
}) {
  let input!: HTMLTextAreaElement
  let picker!: HTMLInputElement
  const [text, setText] = createSignal(props.draft?.text ?? "")
  const [files, setFiles] = createSignal<Attachment[]>(props.draft?.files ?? [])
  const [sending, setSending] = createSignal(false)
  const selected = () => choice(props.sessionID, props.directory)
  const levels = () => find(selected().model)?.model.thinking ?? []
  const key = () => choiceKey(props.sessionID, props.directory)
  const usable = () => !props.disabled && (props.group || (connected() && !!selected().model))
  let epoch = 0
  createEffect(
    on(
      key,
      () => {
        epoch++
        setText(props.draft?.text ?? "")
        setFiles(props.draft?.files ?? [])
      },
      { defer: true },
    ),
  )
  createEffect(() => props.onDraftChange?.({ text: text(), files: files() }))
  onMount(() => {
    if (props.autofocus) input.focus()
  })
  const resize = () => {
    input.style.height = "auto"
    input.style.height = `${Math.min(input.scrollHeight, 320)}px`
  }
  const submit = async () => {
    if (!usable() || sending() || (!text().trim() && !files().length)) return
    const target = key()
    setSending(true)
    try {
      await props.onSubmit({ text: text().trim(), files: files() })
      if (key() === target) {
        setText("")
        setFiles([])
        resize()
      }
    } catch (error) {
      toast({
        kind: "error",
        title: t("error.request", { message: error instanceof Error ? error.message : "MRK-1001" }),
        error,
      })
    } finally {
      setSending(false)
    }
  }
  const attach = (file: File) => {
    if (props.disabled || props.group) return
    const target = epoch
    const reader = new FileReader()
    reader.onload = () => {
      if (target !== epoch || props.disabled) return
      const url = String(reader.result)
      if (file.size + files().reduce((sum, file) => sum + attachmentBytes(file.url), 0) > 2 * 1024 * 1024) {
        toast({ kind: "error", title: t("prompt.attachmentLimit") })
        return
      }
      setFiles((items) => [...items, { filename: file.name || "image.png", mime: file.type || "text/plain", url }])
    }
    reader.onerror = () => toast({ kind: "error", title: t("prompt.attachmentReadFailed") })
    if (file.size > 2 * 1024 * 1024) {
      toast({ kind: "error", title: t("prompt.attachmentLimit") })
      return
    }
    reader.readAsDataURL(file)
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
    if (event.key === "Escape" && props.busy) {
      event.preventDefault()
      props.onStop?.()
    }
  }
  return (
    <div
      class="composer"
      classList={{ compact: props.compact }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        ;[...event.dataTransfer!.files].forEach(attach)
      }}
    >
      <Show when={files().length}>
        <div class="attachments composer-files">
          <For each={files()}>
            {(file, index) => (
              <span class="attachment">
                <AttachmentPreview part={file} directory={props.directory} />
                <button
                  class="icon-button sm"
                  aria-label={t("prompt.removeAttachment", { name: file.filename })}
                  onClick={() => setFiles((items) => items.filter((_, at) => at !== index()))}
                >
                  <X class="icon icon-xs" />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <textarea
        ref={input}
        class="composer-input selectable"
        rows={2}
        aria-label={t("prompt.label")}
        placeholder={props.placeholder ?? t(props.busy ? "prompt.placeholderBusy" : "prompt.placeholder")}
        value={text()}
        disabled={props.disabled}
        onInput={(event) => {
          setText(event.currentTarget.value)
          resize()
        }}
        onKeyDown={keydown}
        onPaste={(event) => {
          const pasted = [...(event.clipboardData?.files ?? [])]
          if (pasted.length) {
            event.preventDefault()
            pasted.forEach(attach)
          }
        }}
      />
      <div class="composer-bar">
        <Show when={!props.group}>
          <Select
            label={t("permissionLevel.label")}
            value={selected().mode}
            disabled={!!props.sessionID || props.busy || props.disabled}
            options={[
              { value: "ask", label: t("permissionLevel.ask"), description: t("permissionLevel.ask.desc") },
              {
                value: "takeover",
                label: t("permissionLevel.fullTakeover"),
                description: t("permissionLevel.fullTakeover.desc"),
                tone: "danger",
                badge: t("permissionLevel.fullTakeover.badge"),
              },
            ]}
            onChange={(mode: "ask" | "takeover") => choose(props.sessionID, props.directory, { mode })}
          />
          <SandboxStatus
            directory={props.directory}
            sessionID={props.sessionID}
            mode={selected().mode}
            busy={props.busy}
          />
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              ;[...(event.currentTarget.files ?? [])].forEach(attach)
              event.currentTarget.value = ""
            }}
          />
          <button
            class="icon-button"
            aria-label={t("prompt.attach")}
            disabled={props.disabled}
            onClick={() => picker.click()}
          >
            <Paperclip class="icon icon-sm" />
          </button>
        </Show>
        <span class="spacer" />
        <Show when={props.sessionID ? usage(props.sessionID) : undefined}>
          {(value) => (
            <span
              class="usage"
              role="status"
              title={t("prompt.usageTokens", { tokens: value().tokens, limit: value().limit ?? 0 })}
            >
              {value().percent ?? 0}%
            </span>
          )}
        </Show>
        <Show when={!props.group}>
          <ModelPicker
            value={selected().model}
            disabled={props.disabled}
            onChange={(model) => choose(props.sessionID, props.directory, { model })}
          />
          <Show when={levels().length}>
            <Select
              class="chip"
              label={t("model.variant.named", { level: selected().variant ?? "" })}
              options={levels().map((value) => ({ value, label: value }))}
              value={selected().variant}
              disabled={props.disabled}
              onChange={(variant) => choose(props.sessionID, props.directory, { variant })}
              display={(option) => (
                <>
                  <Brain class="icon icon-sm" />
                  {option?.label}
                </>
              )}
            />
          </Show>
        </Show>
        <Show
          when={props.busy && !text().trim() && !files().length}
          fallback={
            <button
              class="icon-button solid"
              aria-label={t("prompt.send")}
              disabled={!usable() || sending() || (!text().trim() && !files().length)}
              onClick={() => void submit()}
            >
              <ArrowUp class="icon" />
            </button>
          }
        >
          <button class="icon-button solid stop" aria-label={t("prompt.stop")} onClick={() => props.onStop?.()}>
            <Square class="icon icon-xs" />
          </button>
        </Show>
      </div>
    </div>
  )
}
