import type { Notice } from "@merakcode/sdk"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { createEffect, createSignal, For, Show, untrack } from "solid-js"
import { ago, t } from "../../i18n"
import { taskPath } from "../../lib/route"
import { homeNotices, markNoticeRead, noticeRead, type HomeNotice } from "../../state/groups"
import { noticeText } from "../group/notice"
import { noticeTitle, RequestDialog } from "../group/inbox"

/** Where a notice leads: a request that waits for an answer opens in the inbox, everything else goes to its task. */
export function noticeHref(notice: Pick<Notice, "kind" | "scope" | "id">) {
  if (notice.kind === "permission" || notice.kind === "question") return `/?notice=${encodeURIComponent(notice.id)}`
  return notice.scope.task ? taskPath(notice.scope.task) : "/"
}

/** The notices of the inbox column, newest first; one that waits for a decision can be opened and answered. */
export function InboxColumn(props: { notices: HomeNotice[]; opened?: string; onTask: (id: string) => void }) {
  const [selected, setSelected] = createSignal("")
  const pending = () => props.notices.find((entry) => entry.pending && entry.notice.id === selected())?.notice
  const open = (notice: Notice) => {
    if (notice.kind === "question" || notice.kind === "permission") {
      setSelected(notice.id)
      return
    }
    if (notice.scope.task) props.onTask(notice.scope.task)
  }
  let handled: string | undefined
  createEffect(() => {
    const id = props.opened
    const entry = props.notices.find((item) => item.notice.id === id)
    if (!entry || id === handled) return
    handled = id
    untrack(() => (entry.pending ? open(entry.notice) : markNoticeRead(entry.notice.id)))
  })
  return (
    <section class="home-inbox" aria-label={t("home.inbox")}>
      <Show when={props.notices.length} fallback={<p class="subtle">{t("inbox.empty")}</p>}>
        <For each={props.notices}>
          {(entry) => (
            <article
              class="inbox-notice"
              data-notice={entry.notice.kind}
              data-pending={entry.pending}
              data-read={noticeRead(entry.notice.id)}
            >
              <div class="row">
                <span class={entry.pending ? "badge accent" : "badge neutral"}>{noticeTitle(entry.notice)}</span>
                <Show when={entry.group}>{(group) => <span class="subtle ellipsis">{group().name}</span>}</Show>
                <span class="spacer" />
                <span class="subtle">{ago(Date.parse(entry.notice.time))}</span>
              </div>
              <p>{noticeText(entry.notice.text)}</p>
              <div class="row">
                <Show when={entry.pending}>
                  <button class="button secondary sm" data-open onClick={() => open(entry.notice)}>
                    {t("inbox.decide")}
                  </button>
                </Show>
                <Show when={!entry.pending && entry.notice.scope.task}>
                  <button class="button ghost sm" onClick={() => open(entry.notice)}>
                    {t("usage.task")}
                  </button>
                </Show>
                <Show when={!noticeRead(entry.notice.id)} fallback={<span class="subtle">{t("inbox.read")}</span>}>
                  <button class="button ghost sm" onClick={() => markNoticeRead(entry.notice.id)}>
                    {t("inbox.markRead")}
                  </button>
                </Show>
              </div>
            </article>
          )}
        </For>
      </Show>
      <RequestDialog notice={pending()} onClose={() => setSelected("")} />
    </section>
  )
}

/** The inbox column of the home page: what finished and what waits for this person, across every group. */
export function HomeInbox() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  return (
    <InboxColumn
      notices={homeNotices()}
      opened={typeof params.notice === "string" ? params.notice : undefined}
      onTask={(id) => navigate(taskPath(id))}
    />
  )
}
