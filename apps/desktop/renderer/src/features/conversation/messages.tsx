import type { ModelPart, ToolView } from "@merakcode/sdk"
import Brain from "lucide-solid/icons/brain"
import ChevronRight from "lucide-solid/icons/chevron-right"
import Copy from "lucide-solid/icons/copy"
import Pencil from "lucide-solid/icons/pencil"
import RotateCcw from "lucide-solid/icons/rotate-ccw"
import Undo2 from "lucide-solid/icons/undo-2"
import { createEffect, createSignal, For, Index, Show } from "solid-js"
import { locale, t } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { explain } from "../../state/error"
import { state } from "../../state/store"
import { Markdown } from "../../ui/markdown"
import { toast } from "../../ui/toast"
import { AttachmentPreview } from "./attachment"
import { fill } from "./composer"
import { PlanCard } from "./plan"
import { retry, revertTo, submissionOf } from "./send"
import { Tool } from "./tools"
import { answer, turns, visibleParts, work, type Turn } from "./turns"

function Reasoning(props: { text: string }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="step reasoning">
      <button class="step-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <ChevronRight class="icon icon-sm chevron" />
        <Brain class="icon icon-sm subtle" />
        <span class="step-title">{t("conversation.thinking")}</span>
      </button>
      <Show when={open()}>
        <div class="step-detail reasoning-text">
          <Markdown text={props.text} />
        </div>
      </Show>
    </div>
  )
}

export function Parts(props: {
  parts: ModelPart[]
  sessionID: string
  directory: string
  onReview?: (file: string) => void
}) {
  return (
    <Index each={props.parts}>
      {(part) => (
        <>
          <Show when={part().text}>
            <Markdown text={part().text!} />
          </Show>
          <Show when={part().reasoning?.text}>
            <Reasoning text={part().reasoning!.text!} />
          </Show>
          <Show when={part().toolCall}>
            {(call) => (
              <Tool
                part={state.views[props.sessionID]?.tools[call().id] ?? { ...call(), status: "running", parts: [] }}
                directory={props.directory}
                onReview={props.onReview}
              />
            )}
          </Show>
          <Show when={part().image}>
            {(image) => (
              <span class="attachment">
                <AttachmentPreview
                  directory={props.directory}
                  part={{ mime: image().mime, url: image().url || `data:${image().mime};base64,${image().data ?? ""}` }}
                />
              </span>
            )}
          </Show>
          <Show when={part().document}>
            {(document) => (
              <span class="attachment">
                <AttachmentPreview
                  directory={props.directory}
                  part={{
                    filename: document().name,
                    mime: document().mime,
                    url: `data:${document().mime};base64,${document().data}`,
                  }}
                />
              </span>
            )}
          </Show>
        </>
      )}
    </Index>
  )
}

const failed = (error: Error) => toast({ kind: "error", title: t("error.request", { message: error.message }), error })

const copy = (text: string) =>
  (bridge ? bridge.writeClipboardText(text) : navigator.clipboard.writeText(text)).then(
    () => toast({ kind: "success", title: t("common.copied") }),
    failed,
  )

const textOf = (parts: ModelPart[]) =>
  parts
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n")

/**
 * A message the user sent. Hovering shows Edit (revert to before it and put its text back in the composer) and Revert
 * (hide it and the later messages, restore the files).
 */
function UserBubble(props: { turn: Turn; sessionID: string; directory: string }) {
  const user = () => props.turn.user!
  const revert = () => revertTo(props.sessionID, props.turn.mark!).catch(failed)
  const edit = async () => {
    const draft = submissionOf(user()).text
    await revertTo(props.sessionID, props.turn.mark!)
    fill(props.sessionID, draft)
  }
  return (
    <article class="user-turn" aria-label={t("conversation.you")}>
      <Show when={props.turn.mark}>
        <div class="message-actions">
          <button
            class="icon-button sm"
            aria-label={t("conversation.edit")}
            title={t("conversation.edit")}
            onClick={() => void edit().catch(failed)}
          >
            <Pencil class="icon icon-xs" />
          </button>
          <button
            class="icon-button sm"
            aria-label={t("conversation.revert")}
            title={t("conversation.revertHint")}
            onClick={() => void revert()}
          >
            <Undo2 class="icon icon-xs" />
          </button>
        </div>
      </Show>
      <div class="user-message selectable">
        <Parts parts={visibleParts(user())} sessionID={props.sessionID} directory={props.directory} />
      </div>
    </article>
  )
}

/** Actions after a turn's reply: copy the answer, and retry on the last turn. */
function TurnActions(props: { turn: Turn; last: boolean; sessionID: string; directory: string; text: string }) {
  return (
    <div class="turn-actions">
      <Show when={props.text}>
        <button
          class="icon-button sm"
          aria-label={t("common.copy")}
          title={t("common.copy")}
          onClick={() => void copy(props.text)}
        >
          <Copy class="icon icon-xs" />
        </button>
      </Show>
      <Show when={props.last && props.turn.mark}>
        <button
          class="icon-button sm"
          aria-label={t("conversation.retryTurn")}
          title={t("conversation.retryTurn")}
          onClick={() => void retry(props.sessionID, props.directory, props.turn).catch(failed)}
        >
          <RotateCcw class="icon icon-xs" />
        </button>
      </Show>
    </div>
  )
}

function Changes(props: {
  turn: Turn
  tools: Record<string, ToolView>
  onReview?: () => void
  onFile?: (file: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  const files = () => [
    ...new Set(
      props.turn.replies.flatMap((message) =>
        (message.parts ?? []).flatMap((part) => {
          const call = part.toolCall
          if (!call || !["write_file", "edit_file"].includes(call.name) || props.tools[call.id]?.status !== "completed")
            return []
          const input = call.input
          return input && typeof input === "object" && "path" in input && typeof input.path === "string"
            ? [input.path]
            : []
        }),
      ),
    ),
  ]
  return (
    <Show when={files().length}>
      <div class="changes-card" classList={{ open: open() }}>
        <div class="changes-head">
          <button class="changes-toggle" aria-expanded={open()} onClick={() => setOpen(!open())}>
            <ChevronRight class="icon icon-sm chevron" />
            <span>{t("conversation.changes")}</span>
            <span class="subtle">{t("conversation.changesSummary", { files: files().length })}</span>
          </button>
          <button class="button ghost sm" onClick={() => props.onReview?.()}>
            {t("conversation.review")}
          </button>
        </div>
        <Show when={open()}>
          <div class="change-list scroll">
            <For each={files()}>
              {(file) => (
                <button class="change-file" onClick={() => props.onFile?.(file)}>
                  <span class="name ellipsis">{file}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}

export function Messages(props: {
  sessionID: string
  directory: string
  onReviewFile?: (file: string) => void
  onReview?: () => void
}) {
  const view = () => state.views[props.sessionID]
  let scroll!: HTMLDivElement
  let pinned = true
  createEffect(() => {
    view()?.state.lastSeq
    view()?.live
    queueMicrotask(() => {
      if (scroll && pinned) scroll.scrollTop = scroll.scrollHeight
    })
  })
  return (
    <div
      class="messages scroll"
      role="log"
      aria-label={t("conversation.log")}
      ref={scroll}
      onScroll={() => {
        pinned = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48
      }}
    >
      <div class="messages-inner">
        <Show when={view()?.budget}>
          {(budget) => (
            <details class="context-budget">
              <summary>{t("conversation.budget", { total: budget().total, window: budget().window })}</summary>
              <div class="subtle">
                {t("conversation.budgetParts", {
                  system: budget().system,
                  tools: budget().tools,
                  messages: budget().messages,
                  reserve: budget().reserve,
                })}
              </div>
            </details>
          )}
        </Show>
        <Show when={view()?.state.summaryId}>
          <div class="summary-divider" role="note">
            {t("conversation.rebuilt")}
          </div>
        </Show>
        <Index each={turns(view()?.state.messages ?? [], view()?.state.marks)}>
          {(turn, index) => (
            <section class="turn">
              <Show when={turn().user}>
                <UserBubble turn={turn()} sessionID={props.sessionID} directory={props.directory} />
              </Show>
              <div class="assistant-message selectable">
                <Show when={work(turn()).length}>
                  <details
                    class="turn-work"
                    open={
                      view()?.state.status === "running" &&
                      index === turns(view()?.state.messages ?? [], view()?.state.marks).length - 1
                    }
                  >
                    <summary class="step-head turn-summary">{t("conversation.work")}</summary>
                    <Parts
                      parts={work(turn())}
                      sessionID={props.sessionID}
                      directory={props.directory}
                      onReview={props.onReviewFile}
                    />
                  </details>
                </Show>
                <Show when={answer(turn()).length}>
                  <Parts
                    parts={answer(turn())}
                    sessionID={props.sessionID}
                    directory={props.directory}
                    onReview={props.onReviewFile}
                  />
                </Show>
                <TurnActions
                  turn={turn()}
                  last={index === turns(view()?.state.messages ?? [], view()?.state.marks).length - 1}
                  sessionID={props.sessionID}
                  directory={props.directory}
                  text={textOf(answer(turn()))}
                />
                <Changes
                  turn={turn()}
                  tools={view()?.tools ?? {}}
                  onReview={props.onReview}
                  onFile={props.onReviewFile}
                />
              </div>
            </section>
          )}
        </Index>
        <PlanCard sessionID={props.sessionID} directory={props.directory} />
        <Show when={view()?.live}>
          {(live) => (
            <section class="turn assistant-turn" aria-live="polite">
              <Parts parts={live().parts} sessionID={props.sessionID} directory={props.directory} />
            </section>
          )}
        </Show>
        <Show when={view()?.state.status === "running"}>
          <div class="subtle" role="status">
            {t("conversation.working")}
          </div>
        </Show>
        <Show when={view()?.error}>
          <div class="error" role="alert">
            <div>{explain(view()?.error, locale())?.title ?? view()?.error}</div>
            <div>{explain(view()?.error, locale())?.hint}</div>
            <div class="subtle mono">{view()?.error}</div>
          </div>
        </Show>
        <Index each={view()?.state.warnings ?? []}>
          {(warning) => (
            <div class="error" role="status">
              <div>{explain(warning().code, locale())?.title ?? warning().code}</div>
              <Show when={warning().server}>
                <div>{warning().server}</div>
              </Show>
              <div>{explain(warning().code, locale())?.hint}</div>
              <div class="subtle mono">{warning().code}</div>
            </div>
          )}
        </Index>
      </div>
    </div>
  )
}
