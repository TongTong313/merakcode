import { describe, expect, test } from "vitest"
import { resolveDiffViewerKey, type DiffKeyContext } from "../../src/cli/cmd/tui/routes/diff/diff-keyboard"

function ctx(overrides: Partial<DiffKeyContext> = {}): DiffKeyContext {
  return {
    name: "",
    dialogOpen: false,
    focus: "patches",
    showFileTree: true,
    splitAvailable: true,
    ...overrides,
  }
}

describe("resolveDiffViewerKey", () => {
  test("ignores defaultPrevented events", () => {
    expect(resolveDiffViewerKey(ctx({ name: "q", defaultPrevented: true }))).toEqual({ type: "ignore" })
  })

  describe("with a dialog open", () => {
    test("h / escape close the dialog", () => {
      for (const name of ["h", "escape"] as const) {
        expect(resolveDiffViewerKey(ctx({ name, dialogOpen: true }))).toEqual({
          type: "consume",
          action: "close-dialog",
        })
      }
    })

    test("? is not handled while a dialog is open", () => {
      expect(resolveDiffViewerKey(ctx({ name: "?", dialogOpen: true }))).toEqual({ type: "ignore" })
    })

    test("other keys are ignored and left to the dialog component", () => {
      expect(resolveDiffViewerKey(ctx({ name: "j", dialogOpen: true }))).toEqual({ type: "ignore" })
      expect(resolveDiffViewerKey(ctx({ name: "s", dialogOpen: true }))).toEqual({ type: "ignore" })
    })
  })

  describe("without a dialog", () => {
    test("q / escape close the viewer", () => {
      expect(resolveDiffViewerKey(ctx({ name: "q" }))).toEqual({ type: "consume", action: "close-viewer" })
      expect(resolveDiffViewerKey(ctx({ name: "escape" }))).toEqual({ type: "consume", action: "close-viewer" })
    })

    test("h opens help", () => {
      expect(resolveDiffViewerKey(ctx({ name: "h" }))).toEqual({ type: "consume", action: "open-help" })
    })

    test("? does not open help", () => {
      expect(resolveDiffViewerKey(ctx({ name: "?" }))).toEqual({ type: "ignore" })
    })

    test("tab is not handled while the file tree is hidden", () => {
      expect(resolveDiffViewerKey(ctx({ name: "tab", showFileTree: false }))).toEqual({ type: "ignore" })
      expect(resolveDiffViewerKey(ctx({ name: "\t", showFileTree: false }))).toEqual({ type: "ignore" })
    })

    test("tab toggles focus while the file tree is visible", () => {
      expect(resolveDiffViewerKey(ctx({ name: "tab" }))).toEqual({ type: "consume", action: "toggle-focus" })
    })

    test("s opens the source switcher", () => {
      expect(resolveDiffViewerKey(ctx({ name: "s" }))).toEqual({ type: "consume", action: "open-switch-source" })
    })

    test("v toggles the view only when split is available", () => {
      expect(resolveDiffViewerKey(ctx({ name: "v", splitAvailable: true }))).toEqual({
        type: "consume",
        action: "toggle-view",
      })
      expect(resolveDiffViewerKey(ctx({ name: "v", splitAvailable: false }))).toEqual({ type: "ignore" })
    })

    test("t / 1 / m map to their actions", () => {
      expect(resolveDiffViewerKey(ctx({ name: "t" }))).toEqual({ type: "consume", action: "toggle-file-tree" })
      expect(resolveDiffViewerKey(ctx({ name: "1" }))).toEqual({ type: "consume", action: "toggle-single-patch" })
      expect(resolveDiffViewerKey(ctx({ name: "m" }))).toEqual({ type: "consume", action: "toggle-reviewed" })
    })

    test("n / p switch files", () => {
      expect(resolveDiffViewerKey(ctx({ name: "n" }))).toEqual({ type: "consume", action: "next-file" })
      expect(resolveDiffViewerKey(ctx({ name: "p" }))).toEqual({ type: "consume", action: "prev-file" })
    })

    test("[ / ] jump between hunks", () => {
      expect(resolveDiffViewerKey(ctx({ name: "[" }))).toEqual({ type: "consume", action: "prev-hunk" })
      expect(resolveDiffViewerKey(ctx({ name: "]" }))).toEqual({ type: "consume", action: "next-hunk" })
    })
  })

  describe("with focus on the file tree", () => {
    const files = ctx({ focus: "files" })

    test("j/k or the arrow keys move the selected row", () => {
      expect(resolveDiffViewerKey({ ...files, name: "j" })).toEqual({
        type: "consume",
        action: "move-file-selection",
        offset: 1,
      })
      expect(resolveDiffViewerKey({ ...files, name: "up" })).toEqual({
        type: "consume",
        action: "move-file-selection",
        offset: -1,
      })
    })

    test("enter / space activate the current row", () => {
      for (const name of ["enter", "return", "space", " "] as const) {
        expect(resolveDiffViewerKey({ ...files, name })).toEqual({
          type: "consume",
          action: "activate-file-tree-row",
        })
      }
    })

    test("n/p still switch patch files with the file tree focused", () => {
      expect(resolveDiffViewerKey({ ...files, name: "n" })).toEqual({ type: "consume", action: "next-file" })
    })

    test("unbound keys are ignored", () => {
      expect(resolveDiffViewerKey({ ...files, name: "x" })).toEqual({ type: "ignore" })
    })
  })

  describe("with focus on the patch pane", () => {
    test("j/k scroll the patch", () => {
      expect(resolveDiffViewerKey(ctx({ name: "j" }))).toEqual({ type: "consume", action: "scroll-patch", delta: 1 })
      expect(resolveDiffViewerKey(ctx({ name: "up" }))).toEqual({
        type: "consume",
        action: "scroll-patch",
        delta: -1,
      })
    })

    test("pageup/pagedown and ctrl+f/ctrl+b page through", () => {
      expect(resolveDiffViewerKey(ctx({ name: "pagedown" }))).toEqual({
        type: "consume",
        action: "scroll-patch-page",
        delta: 1,
      })
      expect(resolveDiffViewerKey(ctx({ name: "pageup" }))).toEqual({
        type: "consume",
        action: "scroll-patch-page",
        delta: -1,
      })
      expect(resolveDiffViewerKey(ctx({ name: "f", ctrl: true }))).toEqual({
        type: "consume",
        action: "scroll-patch-page",
        delta: 1,
      })
    })
  })
})
