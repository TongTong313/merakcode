import { createStore } from "solid-js/store"
import { storage } from "../lib/bridge"

export type Tab = "review" | "code" | "browser"
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
  tab: Tab
  /** The review fills the whole window */
  maximized: boolean
  terminal: boolean
  panelWidth: number
  terminalHeight: number
  /** Onboarding was skipped during this launch */
  skipped: boolean
  /** File to open in the code tab (relative to the conversation directory); at lets the same file open again */
  openFile?: { path: string; at: number }
}

export const [ui, setUi] = createStore<UI>({
  palette: false,
  newTeam: false,
  panel: false,
  membersCollapsed: false,
  tab: "review",
  maximized: false,
  terminal: false,
  panelWidth: 560,
  terminalHeight: 260,
  skipped: false,
})

const KEY = "layout"
type Saved = Pick<UI, "panel" | "membersCollapsed" | "tab" | "panelWidth" | "terminalHeight">

export async function restoreLayout() {
  const saved = await storage.get<Partial<Saved>>(KEY, {})
  setUi({ ...saved })
}

export function saveLayout() {
  void storage.set(KEY, {
    panel: ui.panel,
    membersCollapsed: ui.membersCollapsed,
    tab: ui.tab,
    panelWidth: ui.panelWidth,
    terminalHeight: ui.terminalHeight,
  })
}

/** Opens a file in the side panel's code tab (from the review or a file-edit card) */
export function openInCode(path: string) {
  setUi({ panel: true, tab: "code", maximized: false, openFile: { path, at: Date.now() } })
  saveLayout()
}

export function showTab(tab: Tab) {
  setUi({ panel: true, tab })
  saveLayout()
}

export function togglePanel() {
  setUi("panel", (open) => !open)
  if (!ui.panel) setUi("maximized", false)
  saveLayout()
}
