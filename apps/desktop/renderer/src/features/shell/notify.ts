import { useNavigate } from "@solidjs/router"
import { createEffect, onCleanup } from "solid-js"
import { t, type Key } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { groupPath, sessionPath } from "../../lib/route"
import { listen, session, sessionsOf, state } from "../../state/store"
import { groups, groupView, localHuman, markNoticesRead, noticeRead } from "../../state/groups"
import { noticeText } from "../group/notice"

const noticeTitles: Record<string, Key> = {
  permission: "notify.approval",
  question: "notify.question",
  review: "task.status.review",
  plan: "task.phase.planning",
  blocked: "task.status.blocked",
  info: "inbox.info",
  receipt: "inbox.receipt",
  sentinel: "notify.sentinel",
}

/** Background notifications navigate to the parent conversation for child requests. */
export function Notify() {
  const navigate = useNavigate()
  createEffect(() => {
    const inboxes = groups().map((group) => {
      const inbox = groupView(group.id)?.inbox
      return {
        id: group.id,
        title: group.name,
        href: `${groupPath(group.project.directory, group.id)}?view=inbox`,
        unseen: !!inbox && (inbox.todo.length > 0 || inbox.info.some((notice) => !noticeRead(notice.id))),
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
        markNoticesRead(groups().flatMap((group) => groupView(group.id)?.inbox.info.map((notice) => notice.id) ?? []))
      }),
    )
  onCleanup(
    listen((directory, event) => {
      if (document.hasFocus() || typeof Notification === "undefined") return
      if (event.scope.group) {
        if (event.type !== "notice.sent" || !event.payload.to?.includes(localHuman)) return
        const group = groups().find((group) => group.id === event.scope.group)
        if (!group) return
        const key = noticeTitles[event.payload.kind] ?? "inbox.info"
        const href = `${groupPath(group.project.directory, group.id)}?view=inbox&notice=${encodeURIComponent(event.id)}`
        const notification = new Notification(t(key), { body: `${group.name}: ${noticeText(event.payload.text)}` })
        notification.onclick = () => (bridge ? void bridge.focusAndNavigate(href) : navigate(href))
        return
      }
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
