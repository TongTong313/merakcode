import { EngineEventSchema, type Notice } from "@merakcode/sdk"
import { createResource, Show } from "solid-js"
import { t, type Key } from "../../i18n"
import { client } from "../../state/client"
import { Dialog } from "../../ui/dialog"
import { Approval, Question } from "../conversation/dock"

const kindKeys: Record<string, Key> = {
  permission: "notify.approval",
  question: "notify.question",
  review: "task.status.review",
  plan: "task.phase.planning",
  blocked: "task.status.blocked",
  info: "inbox.info",
  receipt: "inbox.receipt",
  sentinel: "notify.sentinel",
  import: "import.title",
}

/** The title of a notice: a finished task says so; the other kinds name what is asked of the person. */
export function noticeTitle(notice: Pick<Notice, "kind" | "scope">) {
  if (notice.kind === "info" && notice.scope.task) return t("inbox.taskDone")
  return t(kindKeys[notice.kind] ?? "inbox.info")
}

/** A permission request or a question that waits in the inbox, opened where the person can answer it. */
export function RequestDialog(props: { notice?: Notice; onClose: () => void }) {
  const [request, { refetch }] = createResource(
    () => props.notice?.request,
    async (id) => EngineEventSchema.parse(await (await client()).events.get({ id })),
  )
  const question = () => {
    if (request.state !== "ready") return
    const event = request()
    if (event?.id === props.notice?.request && event?.type === "question.asked") return event
  }
  const permission = () => {
    if (request.state !== "ready") return
    const event = request()
    if (event?.id === props.notice?.request && event?.type === "permission.requested") return event
  }
  return (
    <Dialog
      open={!!props.notice}
      title={props.notice?.text ?? ""}
      onOpenChange={(open) => !open && props.onClose()}
      footer={
        <button class="button secondary" onClick={props.onClose}>
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
          <Show when={question()}>{(event) => <Question request={event()} />}</Show>
          <Show when={permission()}>{(event) => <Approval request={event()} />}</Show>
        </Show>
      </div>
    </Dialog>
  )
}
