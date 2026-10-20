import { expect, test, vi } from "vitest"
import { Renderable, RGBA, ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { Keybind } from "@merakcode/util/keybind"
import * as KeybindContext from "../../src/cli/cmd/tui/context/keybind"
import * as KVContext from "../../src/cli/cmd/tui/context/kv"
import * as LocalContext from "../../src/cli/cmd/tui/context/local"
import * as LocaleContext from "../../src/cli/cmd/tui/context/locale"
import * as RouteContext from "../../src/cli/cmd/tui/context/route"
import * as SDKContext from "../../src/cli/cmd/tui/context/sdk"
import * as SyncContext from "../../src/cli/cmd/tui/context/sync"
import * as ThemeContext from "../../src/cli/cmd/tui/context/theme"
import * as ToastContext from "../../src/cli/cmd/tui/ui/toast"
import { moveSessionDelete, triggerSessionDelete } from "../../src/cli/cmd/tui/component/session-delete-state"
import { DialogStackProvider, type DialogContext, useDialog } from "../../src/cli/cmd/tui/ui/dialog"
import { setTimeout as delay } from "node:timers/promises"

const panel = RGBA.fromInts(20, 20, 20)
const primary = RGBA.fromInts(40, 180, 200)
const text = RGBA.fromInts(230, 230, 230)
const muted = RGBA.fromInts(140, 140, 140)
const theme = {
  accent: primary,
  background: panel,
  backgroundPanel: panel,
  error: RGBA.fromInts(220, 70, 70),
  primary,
  selectedListItemText: panel,
  text,
  textMuted: muted,
  _hasSelectedListItemText: true,
}

function Probe(props: { ready: (dialog: DialogContext) => void }) {
  props.ready(useDialog())
  return null
}

function hoverPoints(setup: Awaited<ReturnType<typeof testRender>>, label: string) {
  const lines = setup.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(label))
  const x = y === -1 ? -1 : lines[y]!.indexOf(label)
  if (x === -1 || y === -1) throw new Error(`${label} row was not rendered`)

  const target = Renderable.renderablesByNumber.get(setup.renderer.hitTest(x, y))
  if (!target) throw new Error(`${label} hit target was not found`)

  let row: Renderable = target
  while (row.parent && !(row.parent instanceof ScrollBoxRenderable)) row = row.parent
  if (!(row.parent instanceof ScrollBoxRenderable)) throw new Error(`${label} row was not inside a scrollbox`)

  const inside = (candidate: Renderable) => {
    let current: Renderable | null = candidate
    while (current) {
      if (current === row) return true
      current = current.parent
    }
    return false
  }
  const alternate = Array.from({ length: row.width }, (_, offset) => row.screenX + offset).find((candidateX) => {
    const candidate = Renderable.renderablesByNumber.get(setup.renderer.hitTest(candidateX, y))
    return candidate && candidate !== target && inside(candidate)
  })
  if (alternate === undefined) throw new Error(`${label} row did not expose a second hover target`)

  return {
    alternate: { x: alternate, y },
    title: { x, y },
  }
}

test("same-row hover preserves session delete confirmation until the second Ctrl+D", async () => {
  const themeSpy = vi
    .spyOn(ThemeContext, "useTheme")
    .mockReturnValue({ theme } as ReturnType<typeof ThemeContext.useTheme>)
  const localeSpy = vi.spyOn(LocaleContext, "useLocale").mockReturnValue({
    t: (key: string) => key,
  } as ReturnType<typeof LocaleContext.useLocale>)
  const keybindSpy = vi.spyOn(KeybindContext, "useKeybind").mockReturnValue({
    all: {},
    leader: false,
    parse: Keybind.fromParsedKey,
    match: () => false,
    print: () => "",
  })

  let setup: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    const { DialogSelect } = await import("../../src/cli/cmd/tui/ui/dialog-select")
    const deleted: string[] = []
    const moved: string[] = []

    function Sessions() {
      const [ids, setIds] = createSignal(["session-a", "session-b"])
      const [pending, setPending] = createSignal<string>()
      const options = createMemo(() =>
        ids().map((id) => ({
          value: id,
          title: pending() === id ? `confirm ${id}` : id,
        })),
      )

      return (
        <DialogSelect
          title="sessions"
          options={options()}
          skipFilter={true}
          preserveSelection={true}
          current="session-a"
          onMove={(option) => {
            moved.push(option.value)
            setPending(moveSessionDelete(pending(), option.value))
          }}
          keybind={[
            {
              keybind: Keybind.parse("ctrl+d")[0],
              title: "delete",
              onTrigger: (option) => {
                const action = triggerSessionDelete(pending(), option.value)
                if (action.type === "pending") {
                  setPending(action.sessionID)
                  return
                }
                deleted.push(action.sessionID)
                setPending(undefined)
                setIds((current) => current.filter((id) => id !== action.sessionID))
              },
            },
          ]}
        />
      )
    }

    let dialog: DialogContext | undefined
    setup = await testRender(
      () => (
        <DialogStackProvider backgroundColor={panel}>
          <Probe ready={(value) => (dialog = value)} />
        </DialogStackProvider>
      ),
      { width: 100, height: 30, kittyKeyboard: true },
    )
    if (!dialog) throw new Error("Dialog context was not mounted")

    dialog.replace(() => <Sessions />)
    await setup.flush()

    const initial = hoverPoints(setup, "session-a")
    await setup.mockMouse.moveTo(initial.title.x, initial.title.y)

    setup.mockInput.pressKey("d", { ctrl: true })
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("confirm session-a")
    expect(deleted).toEqual([])

    moved.length = 0
    const confirmed = hoverPoints(setup, "confirm session-a")
    await setup.mockMouse.moveTo(confirmed.title.x, confirmed.title.y)
    await setup.mockMouse.moveTo(confirmed.alternate.x, confirmed.alternate.y)
    await setup.mockMouse.moveTo(confirmed.title.x, confirmed.title.y)
    await setup.flush()

    expect(moved).toContain("session-a")
    expect(setup.captureCharFrame()).toContain("confirm session-a")

    setup.mockInput.pressKey("d", { ctrl: true })
    await setup.flush()
    expect(deleted).toEqual(["session-a"])
    expect(setup.captureCharFrame()).not.toContain("session-a")
  } finally {
    setup?.renderer.destroy()
    keybindSpy.mockRestore()
    localeSpy.mockRestore()
    themeSpy.mockRestore()
  }
})

interface Session {
  id: string
  title: string
  parentID?: string
  time: {
    created: number
    updated: number
  }
}

function sessions(): Session[] {
  const now = Date.now()
  return [
    { id: "session-b", title: "Session B", time: { created: now - 2_000, updated: now } },
    { id: "session-a", title: "Session A", time: { created: now - 2_000, updated: now - 1_000 } },
    {
      id: "session-child",
      title: "Session A child",
      parentID: "session-a",
      time: { created: now - 2_000, updated: now - 1_500 },
    },
    {
      id: "session-c",
      title: "Session C",
      time: { created: now - 172_801_000, updated: now - 172_800_000 },
    },
  ]
}

async function renderDialog(
  remove: (sessionID: string) => Promise<{ data?: boolean }>,
  options?: { list?: Session[] },
) {
  const initial = sessions()
  const [route, setRoute] = createSignal<{ type: "home" } | { type: "session"; sessionID: string }>({
    type: "session",
    sessionID: "session-a",
  })
  const [data, setData] = createStore({ session: initial, session_status: {} })
  const calls: Array<{ sessionID: string; throwOnError?: boolean }> = []
  const routes: Array<{ type: string; sessionID?: string }> = []
  const toasts: Array<{ variant: string; message: string }> = []
  const [deleting, setDeleting] = createSignal<string>()

  const navigate = (next: { type: "home" } | { type: "session"; sessionID: string }) => {
    routes.push(next)
    setRoute(next)
  }

  const themeSpy = vi
    .spyOn(ThemeContext, "useTheme")
    .mockReturnValue({ theme } as ReturnType<typeof ThemeContext.useTheme>)
  const localeSpy = vi.spyOn(LocaleContext, "useLocale").mockReturnValue({
    t: (key: string, args?: { key?: string }) => {
      if (key === "session.deleteConfirm") return `Confirm ${args?.key}`
      if (key === "session.deleting") return "Deleting session..."
      if (key === "error.sessionDeleteFailed") return "Failed to delete session"
      return key
    },
  } as ReturnType<typeof LocaleContext.useLocale>)
  const keybindSpy = vi.spyOn(KeybindContext, "useKeybind").mockReturnValue({
    all: {
      session_delete: Keybind.parse("ctrl+d"),
    },
    leader: false,
    parse: Keybind.fromParsedKey,
    match: () => false,
    print: () => "ctrl+d",
  } as ReturnType<typeof KeybindContext.useKeybind>)
  const kvSpy = vi.spyOn(KVContext, "useKV").mockReturnValue({
    get: () => false,
  } as unknown as ReturnType<typeof KVContext.useKV>)
  const localSpy = vi.spyOn(LocalContext, "useLocal").mockReturnValue({
    session: {
      ready: true,
      pinned: () => [],
      togglePin: () => undefined,
      deleting,
      beginDelete: (sessionID: string) => {
        if (deleting()) return false
        setDeleting(sessionID)
        return true
      },
      finishDelete: (sessionID: string) => {
        if (deleting() !== sessionID) return
        setDeleting(undefined)
      },
    },
  } as unknown as ReturnType<typeof LocalContext.useLocal>)
  const routeSpy = vi.spyOn(RouteContext, "useRoute").mockReturnValue({
    get data() {
      return route()
    },
    navigate,
  } as ReturnType<typeof RouteContext.useRoute>)
  const syncSpy = vi.spyOn(SyncContext, "useSync").mockReturnValue({
    data,
    set: setData,
  } as unknown as ReturnType<typeof SyncContext.useSync>)
  const sdkSpy = vi.spyOn(SDKContext, "useSDK").mockReturnValue({
    client: {
      session: {
        list: async () => ({ data: options?.list ?? [...data.session] }),
        delete: (input: { sessionID: string }, options?: { throwOnError?: boolean }) => {
          calls.push({ sessionID: input.sessionID, throwOnError: options?.throwOnError })
          return remove(input.sessionID)
        },
      },
    },
  } as unknown as ReturnType<typeof SDKContext.useSDK>)
  const toastSpy = vi.spyOn(ToastContext, "useToast").mockReturnValue({
    show: (options: { variant: string; message: string }) => toasts.push(options),
  } as unknown as ReturnType<typeof ToastContext.useToast>)

  const { DialogSessionList } = await import("../../src/cli/cmd/tui/component/dialog-session-list")
  let dialog: DialogContext | undefined
  const setup = await testRender(
    () => (
      <DialogStackProvider backgroundColor={panel}>
        <Probe ready={(value) => (dialog = value)} />
      </DialogStackProvider>
    ),
    { width: 100, height: 30, kittyKeyboard: false },
  )
  if (!dialog) throw new Error("Dialog context was not mounted")
  dialog.replace(() => <DialogSessionList />)
  await setup.flush()
  await delay(5)
  await setup.flush()

  return {
    calls,
    data,
    dialog,
    navigate,
    route,
    routes,
    setup,
    toasts,
    cleanup() {
      setup.renderer.destroy()
      toastSpy.mockRestore()
      sdkSpy.mockRestore()
      syncSpy.mockRestore()
      routeSpy.mockRestore()
      localSpy.mockRestore()
      kvSpy.mockRestore()
      keybindSpy.mockRestore()
      localeSpy.mockRestore()
      themeSpy.mockRestore()
    },
  }
}

test("permanently deletes the current session, navigates, and does not repeat an in-flight request", async () => {
  let resolve: ((value: { data: boolean }) => void) | undefined
  const request = new Promise<{ data: boolean }>((done) => {
    resolve = done
  })
  const view = await renderDialog(() => request)

  try {
    const initial = hoverPoints(view.setup, "Session A")
    await view.setup.mockMouse.moveTo(initial.title.x, initial.title.y)
    view.setup.mockInput.pressKey("d", { ctrl: true })
    await view.setup.flush()
    expect(view.setup.captureCharFrame()).toContain("Confirm ctrl+d")
    expect(view.calls).toEqual([])

    view.setup.mockInput.pressKey("d", { ctrl: true })
    await view.setup.flush()
    expect(view.calls).toEqual([{ sessionID: "session-a", throwOnError: true }])
    expect(view.setup.captureCharFrame()).toContain("Deleting session...")
    expect(view.routes).toEqual([])

    view.setup.mockInput.pressKey("d", { ctrl: true })
    await view.setup.flush()
    expect(view.calls).toHaveLength(1)

    view.dialog.pop()
    resolve?.({ data: true })
    await delay(5)
    await view.setup.flush()

    expect(view.data.session.map((session) => session.id)).toEqual(["session-b", "session-c"])
    expect(view.routes).toEqual([{ type: "session", sessionID: "session-c" }])
    expect(view.route()).toEqual({ type: "session", sessionID: "session-c" })
    expect(view.setup.captureCharFrame()).not.toContain("Session A")

    const { DialogSessionList } = await import("../../src/cli/cmd/tui/component/dialog-session-list")
    view.dialog.replace(() => <DialogSessionList />)
    await view.setup.flush()
    expect(view.setup.captureCharFrame()).not.toContain("Session A")
  } finally {
    view.cleanup()
  }
})

test("finishes deleting the current session after closing the sessions dialog", async () => {
  let resolve: ((value: { data: boolean }) => void) | undefined
  const request = new Promise<{ data: boolean }>((done) => {
    resolve = done
  })
  const view = await renderDialog(() => request)

  try {
    view.setup.mockInput.pressKey("d", { ctrl: true })
    view.setup.mockInput.pressKey("d", { ctrl: true })
    await view.setup.flush()

    expect(view.calls).toEqual([{ sessionID: "session-a", throwOnError: true }])
    expect(view.route()).toEqual({ type: "session", sessionID: "session-a" })

    view.dialog.pop()
    await view.setup.flush()

    resolve?.({ data: true })
    await delay(5)
    await view.setup.flush()

    expect(view.data.session.map((session) => session.id)).toEqual(["session-b", "session-c"])
    expect(view.routes).toEqual([{ type: "session", sessionID: "session-c" }])
    expect(view.route()).toEqual({ type: "session", sessionID: "session-c" })

    const { DialogSessionList } = await import("../../src/cli/cmd/tui/component/dialog-session-list")
    view.dialog.replace(() => <DialogSessionList />)
    await view.setup.flush()
    expect(view.setup.captureCharFrame()).not.toContain("Session A")
    expect(view.setup.captureCharFrame()).toContain("Session B")
  } finally {
    view.cleanup()
  }
})

test("shares an in-flight deletion across reopened sessions dialogs", async () => {
  let resolve: ((value: { data: boolean }) => void) | undefined
  const request = new Promise<{ data: boolean }>((done) => {
    resolve = done
  })
  const view = await renderDialog(() => request)

  try {
    view.setup.mockInput.pressKey("d", { ctrl: true })
    view.setup.mockInput.pressKey("d", { ctrl: true })
    await view.setup.flush()
    expect(view.calls).toEqual([{ sessionID: "session-a", throwOnError: true }])

    view.dialog.pop()
    await view.setup.flush()

    const { DialogSessionList } = await import("../../src/cli/cmd/tui/component/dialog-session-list")
    view.dialog.replace(() => <DialogSessionList />)
    await view.setup.flush()
    expect(view.setup.captureCharFrame()).toContain("Deleting session...")

    view.setup.mockInput.pressKey("d", { ctrl: true })
    await view.setup.flush()
    expect(view.calls).toHaveLength(1)

    resolve?.({ data: true })
    await delay(5)
    await view.setup.flush()

    expect(view.data.session.map((session) => session.id)).toEqual(["session-b", "session-c"])
    expect(view.route()).toEqual({ type: "session", sessionID: "session-c" })
    expect(view.setup.captureCharFrame()).not.toContain("Session A")
  } finally {
    view.cleanup()
  }
})

test("does not leave home after the user navigates there during deletion", async () => {
  let resolve: ((value: { data: boolean }) => void) | undefined
  const request = new Promise<{ data: boolean }>((done) => {
    resolve = done
  })
  const view = await renderDialog(() => request)

  try {
    view.setup.mockInput.pressKey("d", { ctrl: true })
    view.setup.mockInput.pressKey("d", { ctrl: true })
    await view.setup.flush()
    expect(view.calls).toEqual([{ sessionID: "session-a", throwOnError: true }])

    view.navigate({ type: "home" })
    resolve?.({ data: true })
    await delay(5)
    await view.setup.flush()

    expect(view.data.session.map((session) => session.id)).toEqual(["session-b", "session-c"])
    expect(view.routes).toEqual([{ type: "home" }])
    expect(view.route()).toEqual({ type: "home" })
  } finally {
    view.cleanup()
  }
})

test("keeps the current route and session list when permanent deletion fails", async () => {
  const view = await renderDialog(() => Promise.reject(new Error("delete request failed")))

  try {
    view.setup.mockInput.pressKey("d", { ctrl: true })
    view.setup.mockInput.pressKey("d", { ctrl: true })
    await delay(5)
    await view.setup.flush()

    expect(view.calls).toEqual([{ sessionID: "session-a", throwOnError: true }])
    expect(view.routes).toEqual([])
    expect(view.route()).toEqual({ type: "session", sessionID: "session-a" })
    expect(view.data.session.map((session) => session.id)).toContain("session-a")
    expect(view.setup.captureCharFrame()).toContain("Session A")
    expect(view.toasts).toEqual([{ variant: "error", message: "delete request failed" }])
  } finally {
    view.cleanup()
  }
})

test("drops ghost sessions when the list dialog opens", async () => {
  const live = sessions().filter((session) => session.id !== "session-a" && session.id !== "session-child")
  const view = await renderDialog(async () => ({ data: true }), { list: live })

  try {
    expect(view.data.session.map((session) => session.id)).not.toContain("session-a")
    expect(view.setup.captureCharFrame()).not.toContain("Session A")
    expect(view.setup.captureCharFrame()).toContain("Session B")
  } finally {
    view.cleanup()
  }
})
