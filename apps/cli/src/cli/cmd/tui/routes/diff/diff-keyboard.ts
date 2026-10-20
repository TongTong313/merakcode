export type DiffViewerFocus = "patches" | "files"

export type DiffKeyAction =
  | { type: "ignore" }
  | { type: "consume"; action: "close-dialog" }
  | { type: "consume"; action: "close-viewer" }
  | { type: "consume"; action: "open-help" }
  | { type: "consume"; action: "toggle-focus" }
  | { type: "consume"; action: "open-switch-source" }
  | { type: "consume"; action: "toggle-view" }
  | { type: "consume"; action: "toggle-file-tree" }
  | { type: "consume"; action: "toggle-single-patch" }
  | { type: "consume"; action: "toggle-reviewed" }
  | { type: "consume"; action: "next-file" }
  | { type: "consume"; action: "prev-file" }
  | { type: "consume"; action: "next-hunk" }
  | { type: "consume"; action: "prev-hunk" }
  | { type: "consume"; action: "move-file-selection"; offset: number }
  | { type: "consume"; action: "activate-file-tree-row" }
  | { type: "consume"; action: "scroll-patch"; delta: number }
  | { type: "consume"; action: "scroll-patch-page"; delta: number }

export type DiffKeyContext = {
  name: string
  ctrl?: boolean
  defaultPrevented?: boolean
  dialogOpen: boolean
  focus: DiffViewerFocus
  showFileTree: boolean
  splitAvailable: boolean
}

/** Resolves a key press to a diff viewer action; pure so it can be unit tested. */
export function resolveDiffViewerKey(ctx: DiffKeyContext): DiffKeyAction {
  if (ctx.defaultPrevented) return { type: "ignore" }

  if (ctx.dialogOpen) {
    if (ctx.name === "h" || ctx.name === "escape") {
      return { type: "consume", action: "close-dialog" }
    }
    return { type: "ignore" }
  }

  if (ctx.name === "q" || ctx.name === "escape") {
    return { type: "consume", action: "close-viewer" }
  }

  if (ctx.name === "h") {
    return { type: "consume", action: "open-help" }
  }

  if (ctx.name === "tab" || ctx.name === "\t") {
    if (!ctx.showFileTree) return { type: "ignore" }
    return { type: "consume", action: "toggle-focus" }
  }

  if (ctx.name === "s") {
    return { type: "consume", action: "open-switch-source" }
  }

  if (ctx.name === "v" && ctx.splitAvailable) {
    return { type: "consume", action: "toggle-view" }
  }

  if (ctx.name === "t") {
    return { type: "consume", action: "toggle-file-tree" }
  }

  if (ctx.name === "1") {
    return { type: "consume", action: "toggle-single-patch" }
  }

  if (ctx.name === "m") {
    return { type: "consume", action: "toggle-reviewed" }
  }

  if (ctx.name === "n") {
    return { type: "consume", action: "next-file" }
  }

  if (ctx.name === "p") {
    return { type: "consume", action: "prev-file" }
  }

  if (ctx.name === "]") {
    return { type: "consume", action: "next-hunk" }
  }

  if (ctx.name === "[") {
    return { type: "consume", action: "prev-hunk" }
  }

  if (ctx.focus === "files") {
    if (ctx.name === "j" || ctx.name === "down") {
      return { type: "consume", action: "move-file-selection", offset: 1 }
    }
    if (ctx.name === "k" || ctx.name === "up") {
      return { type: "consume", action: "move-file-selection", offset: -1 }
    }
    if (ctx.name === "enter" || ctx.name === "return" || ctx.name === "space" || ctx.name === " ") {
      return { type: "consume", action: "activate-file-tree-row" }
    }
    return { type: "ignore" }
  }

  if (ctx.name === "j" || ctx.name === "down") {
    return { type: "consume", action: "scroll-patch", delta: 1 }
  }
  if (ctx.name === "k" || ctx.name === "up") {
    return { type: "consume", action: "scroll-patch", delta: -1 }
  }
  if (ctx.name === "pagedown" || (ctx.ctrl && ctx.name === "f")) {
    return { type: "consume", action: "scroll-patch-page", delta: 1 }
  }
  if (ctx.name === "pageup" || (ctx.ctrl && ctx.name === "b")) {
    return { type: "consume", action: "scroll-patch-page", delta: -1 }
  }

  return { type: "ignore" }
}
