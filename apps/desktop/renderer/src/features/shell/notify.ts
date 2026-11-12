import { useNavigate } from "@solidjs/router"
import { createEffect, onCleanup } from "solid-js"
import { toast } from "../../ui/toast"
import { noticeHref } from "../start/inbox"
import { noticeTitle } from "../group/inbox"
import { t } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { groupPath, sessionPath } from "../../lib/route"
import { listen, session, sessionsOf, state } from "../../state/store"
import { groups, groupView, localHuman, markNoticesRead, noticeRead, unseenNotices } from "../../state/groups"
import { noticeText } from "../group/notice"

/** Background notifications navigate to the parent conversation for child requests. */
export function Notify() {
  const navigate = useNavigate()
  createEffect(() => {
    const inboxes = groups().map((group) => {
      const inbox = groupView(group.id)?.inbox
      return {
        id: group.id,
        title: group.name,
        href: groupPath(group.project.directory, group.id),
        unseen: !!inbox && [...inbox.todo, ...inbox.info].some((notice) => !noticeRead(notice.id)),
      }
    })
    const conversations = state.folders.flatMap((folder) =>
      sessionsOf(folder).map((session) => ({
        id: session.id,
        title: session.title || t("sidebar.untitled"),
        href: sessionPath(session.directory, session.id),
      })),
    )
    const items = [...inboxes, ...conversations]
    bridge?.pushTrayState({
      recent: items.slice(0, 5),
      more: items.slice(5, 25),
      hasNotifications: inboxes.some((inbox) => inbox.unseen),
    })
  })
  if (bridge)
    onCleanup(
      bridge.onClearNotifications(() => {
        markNoticesRead(unseenNotices())
      }),
    )
  const announced = new Set<string>()
  onCleanup(
    listen((directory, event) => {
      if (event.type === "notice.sent" && event.payload.to?.includes(localHuman) && event.payload.kind !== "receipt") {
        if (announced.has(event.id)) return
        announced.add(event.id)
        const notice = { id: event.id, kind: event.payload.kind, scope: event.scope }
        const group = groups().find((group) => group.id === event.scope.group)
        const body = group ? `${group.name}: ${noticeText(event.payload.text)}` : noticeText(event.payload.text)
        const href = noticeHref(notice)
        if (document.hasFocus() || typeof Notification === "undefined") {
          toast({ kind: "info", title: noticeTitle(notice), detail: body, onSelect: () => navigate(href) })
          return
        }
        const notification = new Notification(noticeTitle(notice), { body })
        notification.onclick = () => (bridge ? void bridge.focusAndNavigate(href) : navigate(href))
        return
      }
      if (document.hasFocus() || typeof Notification === "undefined") return
      if (event.scope.group) return
      if (!event.scope.session) return
      const current = session(event.scope.session)
      const id = current?.parentID ?? event.scope.session
      const title =
        event.type === "sentinel.flagged"
          ? t("notify.sentinel")
          : event.type === "turn.finished" && !current?.parentID
            ? t("notify.done")
            : (event.type === "permission.requested" && !event.payload.leader) || event.type === "permission.escalated"
              ? t("notify.approval")
              : event.type === "question.asked"
                ? t("notify.question")
                : undefined
      if (!title) return
      const parent = session(id)
      const href = sessionPath(parent?.directory ?? directory, id)
      const notification = new Notification(title, { body: parent?.title ?? "" })
      notification.onclick = () => (bridge ? void bridge.focusAndNavigate(href) : navigate(href))
    }),
  )
  return null
}
