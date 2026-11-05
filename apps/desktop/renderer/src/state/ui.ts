import { createStore } from "solid-js/store"
import { storage } from "../lib/bridge"
import { openPanel, panels, togglePanels } from "../features/panel/workspace"
import { t } from "../i18n"
import { toast } from "../ui/toast"

export type SettingsSection =
  | "general"
  | "models"
  | "permissions"
  | "mcp"
  | "agentConnections"
  | "collaboration"
  | "skills"
  | "plugins"
  | "rules"
  | "memory"
  | "about"

/** UI layout state; panel width, tab and terminal height are saved and restored on the next launch */
type UI = {
  settings?: SettingsSection
  palette: boolean
  /** The new-team dialog is open */
  newTeam: boolean
  panel: boolean
  /** The member column of a group conversation shows only avatars */
  membersCollapsed: boolean
  /** The review fills the whole window */
  maximized: boolean
  panelWidth: number
  /** Onboarding was skipped during this launch */
  skipped: boolean
}

export const [ui, setUi] = createStore<UI>({
  palette: false,
  newTeam: false,
  panel: false,
  membersCollapsed: false,
  maximized: false,
  panelWidth: 560,
  skipped: false,
})

const KEY = "layout"
type Saved = Pick<UI, "membersCollapsed">

export async function restoreLayout() {
  const saved = await storage.get<Partial<Saved>>(KEY, {})
  if (typeof saved.membersCollapsed === "boolean") setUi("membersCollapsed", saved.membersCollapsed)
}

export function saveLayout() {
  void panels()?.update({ visible: ui.panel, width: ui.panelWidth })
  void storage.set(KEY, {
    membersCollapsed: ui.membersCollapsed,
  })
}

/** Opens a file in the side panel's code tab (from the review or a file-edit card) */
export function openInCode(path: string) {
  setUi({ panel: true, maximized: false })
  void openPanel({ kind: "file", path: path.replace(/\\/g, "/") }).catch((error: unknown) =>
    toast({ kind: "error", title: t("error.request", { message: String(error) }), error }),
  )
  saveLayout()
}

export function togglePanel() {
  setUi("maximized", false)
  void togglePanels()
}

/** Opens the one editable session plan in the existing code editor. */
export function openPlanInCode(sessionID: string) {
  setUi({ panel: true, maximized: false })
  void openPanel({ kind: "file", path: `Plan-${sessionID}.md`, planSessionID: sessionID }).catch((error: unknown) =>
    toast({ kind: "error", title: t("error.request", { message: String(error) }), error }),
  )
  saveLayout()
}
