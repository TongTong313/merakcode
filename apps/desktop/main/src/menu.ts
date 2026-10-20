import { Menu, type MenuItemConstructorOptions } from "electron"
import type { AppLocale } from "../../renderer/src/desktop/bridge-contract"

/**
 * Application menu. Shortcuts the UI handles itself (zoom, open project, ...) are only displayed here, not
 * registered; otherwise the menu would consume the keys before the UI sees them.
 */
export type Actions = {
  newWindow: () => void
  openFolder: () => void
  settings: () => void
  checkUpdates: () => void
  restartBackend: () => void
  logs: () => void
  diagnostics: () => void
  homepage: () => void
  issues: () => void
  about: () => void
}

const text = {
  zh: {
    about: "关于 MerakCode",
    settings: "设置…",
    updates: "检查更新…",
    file: "文件",
    newWindow: "新建窗口",
    openFolder: "打开文件夹…",
    edit: "编辑",
    view: "视图",
    reload: "重新载入",
    zoomIn: "放大",
    zoomOut: "缩小",
    zoomReset: "实际大小",
    fullscreen: "切换全屏",
    window: "窗口",
    help: "帮助",
    homepage: "项目主页",
    issues: "反馈问题",
    logs: "打开日志目录",
    diagnostics: "导出诊断信息…",
    restart: "重启本地服务",
    devtools: "开发者工具",
  },
  en: {
    about: "About MerakCode",
    settings: "Settings…",
    updates: "Check for Updates…",
    file: "File",
    newWindow: "New Window",
    openFolder: "Open Folder…",
    edit: "Edit",
    view: "View",
    reload: "Reload",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    zoomReset: "Actual Size",
    fullscreen: "Toggle Full Screen",
    window: "Window",
    help: "Help",
    homepage: "Homepage",
    issues: "Report an Issue",
    logs: "Open Logs Folder",
    diagnostics: "Export Diagnostics…",
    restart: "Restart Local Service",
    devtools: "Developer Tools",
  },
}

export namespace AppMenu {
  export function template(
    locale: AppLocale,
    actions: Actions,
    platform = process.platform,
  ): MenuItemConstructorOptions[] {
    const t = text[locale]
    const mac = platform === "darwin"
    const shown = (accelerator: string) => ({ accelerator, registerAccelerator: false })
    return [
      ...(mac
        ? [
            {
              label: "MerakCode",
              submenu: [
                { label: t.about, click: actions.about },
                { label: t.updates, click: actions.checkUpdates },
                { type: "separator" },
                { label: t.settings, accelerator: "CmdOrCtrl+,", click: actions.settings },
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
              ] satisfies MenuItemConstructorOptions[],
            },
          ]
        : []),
      {
        label: t.file,
        submenu: [
          { label: t.newWindow, accelerator: "CmdOrCtrl+Shift+N", click: actions.newWindow },
          { label: t.openFolder, ...shown("CmdOrCtrl+O"), click: actions.openFolder },
          ...(mac
            ? ([{ type: "separator" }, { role: "close" }] satisfies MenuItemConstructorOptions[])
            : ([
                { type: "separator" },
                { label: t.settings, accelerator: "CmdOrCtrl+,", click: actions.settings },
                { type: "separator" },
                { role: "quit" },
              ] satisfies MenuItemConstructorOptions[])),
        ],
      },
      {
        label: t.edit,
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: t.view,
        submenu: [
          { label: t.reload, role: "reload", ...shown("CmdOrCtrl+R") },
          { type: "separator" },
          { label: t.zoomIn, ...shown("CmdOrCtrl+=") },
          { label: t.zoomOut, ...shown("CmdOrCtrl+-") },
          { label: t.zoomReset, ...shown("CmdOrCtrl+0") },
          { type: "separator" },
          { label: t.fullscreen, role: "togglefullscreen" },
        ],
      },
      ...(mac ? [{ label: t.window, role: "windowMenu" as const }] : []),
      {
        label: t.help,
        role: "help",
        submenu: [
          { label: t.homepage, click: actions.homepage },
          { label: t.issues, click: actions.issues },
          { type: "separator" },
          { label: t.logs, click: actions.logs },
          { label: t.diagnostics, click: actions.diagnostics },
          { label: t.restart, click: actions.restartBackend },
          { label: t.devtools, role: "toggleDevTools" },
          ...(mac
            ? []
            : ([
                { type: "separator" },
                { label: t.updates, click: actions.checkUpdates },
                { label: t.about, click: actions.about },
              ] satisfies MenuItemConstructorOptions[])),
        ],
      },
    ]
  }

  export function apply(locale: AppLocale, actions: Actions) {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template(locale, actions)))
  }
}
