import { EngineEventSchema, type Inbox, type Notice } from "@merakcode/sdk"
import { createEffect, createResource, createSignal, For, Show, untrack } from "solid-js"
import { t, type Key } from "../../i18n"
import { localHuman, markNoticeRead, noticeRead } from "../../state/groups"
import { client } from "../../state/client"
import { Dialog } from "../../ui/dialog"
import { Approval, Question } from "../conversation/dock"
import { noticeText } from "./notice"

const kindKeys: Record<string, Key> = {
  permission: "notify.approval",
  question: "notify.question",
  review: "task.status.review",
  plan: "task.phase.planning",
  blocked: "task.status.blocked",
  info: "inbox.info",
  receipt: "inbox.receipt",
  sentinel: "notify.sentinel",
}

export function GroupInbox(props: { inbox: Inbox; notice?: string; onTask: (id: string) => void }) {
  const [selected, setSelected] = createSignal("")
  const pending = () => props.inbox.todo.find((notice) => notice.id === selected())
  const [request, { refetch }] = createResource(
    () => pending()?.request,
    async (id) => EngineEventSchema.parse(await (await client()).events.get({ id })),
  )
  const question = () => {
    if (request.state !== "ready") return
    const event = request()
    if (event?.id === pending()?.request && event?.type === "question.asked") return event
  }
  const permission = () => {
    if (request.state !== "ready") return
    const event = request()
    if (event?.id === pending()?.request && event?.type === "permission.requested") return event
  }
  const open = (notice: Notice) => {
    if (notice.kind === "question" || notice.kind === "permission") {
      setSelected(notice.id)
      return
    }
    if (notice.scope.task) props.onTask(notice.scope.task)
  }
  let opened: string | undefined
  createEffect(() => {
    const id = props.notice
    const notice = [...props.inbox.todo, ...props.inbox.info].find((notice) => notice.id === id)
    if (!notice || id === opened) return
    opened = id
    untrack(() => {
      if (props.inbox.info.includes(notice)) markNoticeRead(notice.id)
      else open(notice)
    })
  })
  return (
    <section class="group-inbox scroll" aria-label={t("inbox.title")}>
      <section aria-label={t("inbox.todo")}>
        <h2>{t("inbox.todo")}</h2>
        <Show when={props.inbox.todo.length} fallback={<p class="subtle">{t("inbox.noTodo")}</p>}>
          <For each={props.inbox.todo}>
            {(notice) => (
              <article class="inbox-notice">
                <span class="subtle">{kindKeys[notice.kind] ? t(kindKeys[notice.kind]!) : notice.kind}</span>
                <button class="button ghost" onClick={() => open(notice)}>
                  {noticeText(notice.text)}
                </button>
              </article>
            )}
          </For>
        </Show>
      </section>
      <section aria-label={t("inbox.info")}>
        <h2>{t("inbox.info")}</h2>
        <Show when={props.inbox.info.length} fallback={<p class="subtle">{t("inbox.noInfo")}</p>}>
          <For each={props.inbox.info}>
            {(notice) => (
              <article class="inbox-notice" data-read={noticeRead(notice.id)}>
                <Show when={notice.kind === "sentinel"}>
                  <strong>{t("notify.sentinel")}</strong>
                </Show>
                <p>{noticeText(notice.text)}</p>
                <Show when={notice.scope.task}>
                  <button class="button ghost sm" onClick={() => open(notice)}>
                    {t("usage.task")}
                  </button>
                </Show>
                <Show when={!noticeRead(notice.id)} fallback={<span class="subtle">{t("inbox.read")}</span>}>
                  <button class="button secondary sm" onClick={() => markNoticeRead(notice.id)}>
                    {t("inbox.markRead")}
                  </button>
                </Show>
              </article>
            )}
          </For>
        </Show>
      </section>
      <Dialog
        open={!!pending()}
        title={pending()?.text ?? ""}
        onOpenChange={(open) => !open && setSelected("")}
        footer={
          <button class="button secondary" onClick={() => setSelected("")}>
            {t("common.close")}
          </button>
        }
      >
        <div class="dialog-body">
          <Show
            when={!request.error}
            fallback={
              <button class="button secondary" onClick={() => void refetch()}>
                {t("error.retry")}
              </button>
            }
          >
            <Show when={request.loading}>
              <p role="status">{t("inbox.loading")}</p>
            </Show>
            <Show when={question()}>{(event) => <Question request={event()} human={localHuman} />}</Show>
            <Show when={permission()}>{(event) => <Approval request={event()} human={localHuman} />}</Show>
          </Show>
        </div>
      </Dialog>
    </section>
  )
}
