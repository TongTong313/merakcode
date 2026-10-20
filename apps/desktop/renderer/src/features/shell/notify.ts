import { useNavigate } from "@solidjs/router"
import { onCleanup } from "solid-js"
import { rootOf } from "@merakcode/sdk/store"
import { t } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { sameDir, sessionPath } from "../../lib/route"
import { listen, session, state } from "../../state/store"

/**
 * Sidebar project that owns the event's directory (which may be a worktree); conversation routes are built from the
 * project directory
 */
const folderOf = (directory: string) =>
  state.folders.find(
    (folder) =>
      sameDir(folder.directory, directory) || folder.project?.sandboxes?.some((dir) => sameDir(dir, directory)),
  )?.directory ?? directory

/**
 * While the window is in the background, shows a system notification when a conversation finishes or needs a
 * permission or an answer; clicking it returns to that conversation
 */
export function Notify() {
  const navigate = useNavigate()
  onCleanup(
    listen((directory, event) => {
      if (document.hasFocus() || typeof Notification === "undefined") return
      const target =
        event.type === "session.idle"
          ? // A finished subagent session does not count; wait for the main conversation
            session(event.properties.sessionID)?.parentID
            ? undefined
            : { id: event.properties.sessionID, title: t("notify.done") }
          : event.type === "permission.asked"
            ? {
                id: event.properties.root ?? rootOf(state.sessions, event.properties.sessionID),
                title: t("notify.approval"),
              }
            : event.type === "question.asked"
              ? { id: rootOf(state.sessions, event.properties.sessionID), title: t("notify.question") }
              : undefined
      if (!target) return
      const href = sessionPath(folderOf(directory), target.id)
      const notification = new Notification(target.title, { body: session(target.id)?.title ?? "" })
      // On desktop the main process brings the window to the front before navigating
      notification.onclick = () => (bridge ? void bridge.focusAndNavigate(href) : navigate(href))
    }),
  )
  return null
}
