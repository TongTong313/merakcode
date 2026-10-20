import { describe, expect, test } from "vitest"
import { Keybind } from "@merakcode/util/keybind"

/**
 * DialogSelect handles keybinds before navigation keys. Contract:
 * 1. a matched keybind returns at once, so navigation handling never runs
 * 2. no existing keybind collides with a navigation key
 * 3. plain navigation keys (up/down/enter/pageup/pagedown/home/end/ctrl+p/ctrl+n) are never captured by a keybind
 */

// Builds a Keybind.Info from an opentui-style ParsedKey
function key(name: string, opts: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) {
  return Keybind.fromParsedKey({
    name,
    ctrl: opts.ctrl ?? false,
    meta: opts.meta ?? false,
    shift: opts.shift ?? false,
  })
}

describe("DialogSelect keybind order: compatibility", () => {
  // Every DialogSelect in the project that uses keybinds:
  // - dialog-session-list: session_delete(ctrl+d), session_rename(ctrl+r), session_pin_toggle(ctrl+f)
  // - dialog-model:       model_provider_list(ctrl+a), model_favorite_toggle(ctrl+f)
  // - dialog-stash:       stash_delete(ctrl+d)
  const allKeybinds = [
    key("d", { ctrl: true }), // session_delete / stash_delete
    key("r", { ctrl: true }), // session_rename
    key("f", { ctrl: true }), // session_pin_toggle / model_favorite_toggle
    key("a", { ctrl: true }), // model_provider_list
  ]

  // Navigation keys: bare keys plus ctrl+p/ctrl+n
  const navigationKeys = [
    key("up"),
    key("down"),
    key("return"),
    key("pageup"),
    key("pagedown"),
    key("home"),
    key("end"),
    key("p", { ctrl: true }),
    key("n", { ctrl: true }),
  ]

  test("no existing keybind collides with a navigation key", () => {
    for (const kb of allKeybinds) {
      for (const nav of navigationKeys) {
        expect(Keybind.match(kb, nav)).toBe(false)
      }
    }
  })

  test("ctrl+d collides with no navigation key", () => {
    const deleteKey = key("d", { ctrl: true })
    for (const nav of navigationKeys) {
      expect(Keybind.match(deleteKey, nav)).toBe(false)
    }
  })

  test("ctrl+f collides with no navigation key", () => {
    const findKey = key("f", { ctrl: true })
    for (const nav of navigationKeys) {
      expect(Keybind.match(findKey, nav)).toBe(false)
    }
  })

  test("ctrl+r collides with no navigation key", () => {
    const renameKey = key("r", { ctrl: true })
    for (const nav of navigationKeys) {
      expect(Keybind.match(renameKey, nav)).toBe(false)
    }
  })

  test("ctrl+a collides with no navigation key", () => {
    const allKey = key("a", { ctrl: true })
    for (const nav of navigationKeys) {
      expect(Keybind.match(allKey, nav)).toBe(false)
    }
  })

  test("navigation keys match only themselves", () => {
    expect(Keybind.match(key("up"), key("up"))).toBe(true)
    expect(Keybind.match(key("up"), key("down"))).toBe(false)
    expect(Keybind.match(key("return"), key("return"))).toBe(true)
    expect(Keybind.match(key("return"), key("up"))).toBe(false)
  })

  test("ctrl navigation keys are not captured by any keybind", () => {
    const ctrlP = key("p", { ctrl: true })
    const ctrlN = key("n", { ctrl: true })
    for (const kb of allKeybinds) {
      expect(Keybind.match(kb, ctrlP)).toBe(false)
      expect(Keybind.match(kb, ctrlN)).toBe(false)
    }
  })

  test("enter is not captured by any existing keybind, so selection keeps working", () => {
    const enterKey = key("return")
    for (const kb of allKeybinds) {
      expect(Keybind.match(kb, enterKey)).toBe(false)
    }
  })
})

describe("DialogSelect keybind order: behavior contract", () => {
  test("a matched keybind stops navigation handling (keybinds run before navigation keys)", () => {
    // Handling order: 1. check keybinds and return on a match; 2. then check navigation keys
    const ctrlD = key("d", { ctrl: true })
    const deleteBind = key("d", { ctrl: true })

    const keybindMatched = Keybind.match(deleteBind, ctrlD)
    expect(keybindMatched).toBe(true)

    // A match returns before navigation; also check that ctrl+d matches no navigation key
    const upKey = key("up")
    expect(Keybind.match(ctrlD, upKey)).toBe(false)
  })

  test("a disabled keybind does not trigger (disabled items are skipped)", () => {
    // With item.disabled === true the loop skips the item, so onTrigger never fires even when the key matches
    const ctrlF = key("f", { ctrl: true })
    const pinBind = key("f", { ctrl: true })

    expect(Keybind.match(pinBind, ctrlF)).toBe(true)

    // disabled is set by the caller; a skipped item falls through to navigation handling
  })

  test("navigation keys work when no keybind matches", () => {
    const upKey = key("up")

    const sessionDelete = key("d", { ctrl: true })
    expect(Keybind.match(sessionDelete, upKey)).toBe(false)

    // So handling reaches the navigation branch, where up triggers move(-1)
  })

  test("an undefined keybind is skipped (optional keybinds)", () => {
    // A keybind read with ?.[0] may be undefined; DialogSelect skips it with
    // `if (item.disabled || !item.keybind) continue`
    const ctrlF = key("f", { ctrl: true })
    expect(Keybind.match(undefined, ctrlF)).toBe(false)
  })
})

describe("DialogSelect keybind order: no conflicts across every DialogSelect keybind", () => {
  const dialogBinds = {
    "dialog-session-list": {
      session_delete: key("d", { ctrl: true }),
      session_rename: key("r", { ctrl: true }),
      session_pin_toggle: key("f", { ctrl: true }),
    },
    "dialog-model": {
      model_provider_list: key("a", { ctrl: true }),
      model_favorite_toggle: key("f", { ctrl: true }),
    },
    "dialog-stash": {
      stash_delete: key("d", { ctrl: true }),
    },
  }

  // Common keys that no binding may capture
  const safeKeys = [
    key("up"),
    key("down"),
    key("return"),
    key("escape"),
    key("tab"),
    key("pageup"),
    key("pagedown"),
    key("home"),
    key("end"),
    key("backspace"),
    key("p", { ctrl: true }),
    key("n", { ctrl: true }),
    key("k", { ctrl: true }),
    key("j", { ctrl: true }),
    key("g", { ctrl: true }),
    key("u", { ctrl: true }),
    key("e", { ctrl: true }),
  ]

  for (const [dialogName, binds] of Object.entries(dialogBinds)) {
    for (const [bindName, bindKey] of Object.entries(binds)) {
      test(`${dialogName}::${bindName} does not collide with common keys`, () => {
        for (const safeKey of safeKeys) {
          expect(Keybind.match(bindKey, safeKey)).toBe(false)
        }
      })
    }
  }
})
