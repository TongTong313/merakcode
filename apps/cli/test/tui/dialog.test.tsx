import { describe, expect, test } from "vitest"
import { RGBA, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, For, onMount, type JSX } from "solid-js"
import { DialogStackProvider, type DialogContext, useDialog, useDialogKeyboard } from "../../src/cli/cmd/tui/ui/dialog"

const background = RGBA.fromInts(20, 20, 20)

interface ProbeProps {
  ready: (dialog: DialogContext) => void
}

function Probe(props: ProbeProps) {
  props.ready(useDialog())
  return null
}

interface ParentDialogProps {
  mounted: () => void
}

function ParentDialog(props: ParentDialogProps) {
  const dialog = useDialog()
  const options = ["first", "second", "third"]
  const [selected, setSelected] = createSignal(0)
  let input: InputRenderable
  let scroll: ScrollBoxRenderable

  useDialogKeyboard((evt) => {
    if (evt.defaultPrevented) return
    if (evt.name !== "down") return
    setSelected((value) => Math.min(value + 1, options.length - 1))
    scroll.scrollTo(selected() + 1)
  })

  onMount(() => {
    props.mounted()
    dialog.setSize("large")
    input.focus()
  })

  return (
    <box>
      <text>selected: {options[selected()]}</text>
      <input id="parent-input" ref={(value) => (input = value)} value="parent draft" />
      <scrollbox id="parent-scroll" ref={(value) => (scroll = value)} height={2}>
        <For each={["row zero", "row one", "row two", "row three"]}>{(row) => <text>{row}</text>}</For>
      </scrollbox>
    </box>
  )
}

function ChildDialog() {
  let input: InputRenderable
  onMount(() => input.focus())
  return <input id="child-input" ref={(value) => (input = value)} value="child draft" />
}

interface FocusDialogProps {
  id: string
}

function FocusDialog(props: FocusDialogProps) {
  let input: InputRenderable
  onMount(() => input.focus())
  return <input id={props.id} ref={(value) => (input = value)} value={props.id} />
}

interface EscapeDialogProps {
  handled: () => void
}

function EscapeDialog(props: EscapeDialogProps) {
  useDialogKeyboard((evt) => {
    if (evt.name !== "escape") return
    props.handled()
    evt.preventDefault()
    evt.stopPropagation()
  })
  return <text>editing</text>
}

interface EscapeActionDialogProps {
  action: (dialog: DialogContext) => void
}

function EscapeActionDialog(props: EscapeActionDialogProps) {
  const dialog = useDialog()
  useDialogKeyboard((evt) => {
    if (evt.name === "escape") props.action(dialog)
  })
  return <text>action</text>
}

function OutsideInput() {
  let input: InputRenderable
  onMount(() => input.focus())
  return <input id="outside-input" ref={(value) => (input = value)} value="outside draft" />
}

async function renderDialog(children?: () => JSX.Element) {
  let dialog: DialogContext | undefined
  const setup = await testRender(
    () => (
      <DialogStackProvider backgroundColor={background}>
        {children?.()}
        <Probe ready={(value) => (dialog = value)} />
      </DialogStackProvider>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  if (!dialog) throw new Error("Dialog context was not mounted")
  return { ...setup, dialog }
}

function close(closed: Map<string, number>, name: string) {
  return () => closed.set(name, (closed.get(name) ?? 0) + 1)
}

interface EscapeAction {
  name: string
  stack: number
  parent?: number
  run: (dialog: DialogContext, closed: Map<string, number>) => void
}

const actions = [
  {
    name: "pop",
    stack: 1,
    run: (dialog) => dialog.pop(),
  },
  {
    name: "replace",
    stack: 2,
    run: (dialog, closed) => dialog.replace(() => <text>replacement</text>, close(closed, "replacement")),
  },
  {
    name: "clear",
    stack: 0,
    parent: 1,
    run: (dialog) => dialog.clear(),
  },
] satisfies EscapeAction[]

describe("DialogStackProvider", () => {
  test("push, pop, replace, and clear close exactly the entries they remove", async () => {
    const closed = new Map<string, number>()
    const view = (name: string) => () => <text>{name}</text>
    const setup = await renderDialog()
    const { dialog } = setup

    try {
      dialog.replace(view("parent"), close(closed, "parent"))
      dialog.push(view("child"), close(closed, "child"))
      dialog.push(view("grandchild"), close(closed, "grandchild"))
      dialog.lock()
      expect(dialog.stack).toHaveLength(3)

      dialog.replace(view("replacement"), close(closed, "replacement"))
      expect(dialog.stack).toHaveLength(3)
      expect(dialog.locked).toBe(true)
      expect(closed.get("grandchild")).toBe(1)
      expect(closed.get("parent")).toBeUndefined()
      expect(closed.get("child")).toBeUndefined()

      dialog.unlock()
      dialog.pop()
      expect(dialog.stack).toHaveLength(2)
      expect(closed.get("replacement")).toBe(1)

      dialog.clear()
      dialog.clear()
      expect(dialog.stack).toHaveLength(0)
      expect(Object.fromEntries(closed)).toEqual({
        grandchild: 1,
        replacement: 1,
        child: 1,
        parent: 1,
      })
    } finally {
      setup.renderer.destroy()
    }
  })

  test("Escape and background clicks dismiss only the unlocked top entry", async () => {
    const closed = new Map<string, number>()
    const view = (name: string) => () => <text>{name}</text>
    const setup = await renderDialog()
    const { dialog } = setup

    try {
      dialog.lock()
      expect(dialog.locked).toBe(true)
      dialog.replace(view("parent"), close(closed, "parent"))
      expect(dialog.locked).toBe(true)
      dialog.push(view("child"), close(closed, "child"))
      await setup.flush()

      setup.mockInput.pressEscape()
      await setup.flush()
      expect(dialog.stack).toHaveLength(1)
      expect(closed.get("child")).toBe(1)
      expect(closed.get("parent")).toBeUndefined()
      expect(dialog.locked).toBe(true)

      dialog.push(view("locked child"), close(closed, "locked child"))
      dialog.lock()
      await setup.flush()
      setup.mockInput.pressEscape()
      await setup.mockMouse.click(1, 1)
      await setup.flush()
      expect(dialog.stack).toHaveLength(2)
      expect(closed.get("locked child")).toBeUndefined()

      dialog.unlock()
      await setup.mockMouse.click(1, 1)
      await setup.flush()
      expect(dialog.stack).toHaveLength(1)
      expect(closed.get("locked child")).toBe(1)

      await setup.mockMouse.click(1, 1)
      await setup.flush()
      expect(dialog.stack).toHaveLength(1)
      expect(closed.get("parent")).toBeUndefined()
    } finally {
      setup.renderer.destroy()
    }
  })

  test("repeated Escape and background input close one top entry at a time exactly once", async () => {
    const closed = new Map<string, number>()
    const view = (name: string) => () => <text>{name}</text>
    const setup = await renderDialog()
    const { dialog } = setup

    try {
      dialog.push(view("parent"), close(closed, "parent"))
      dialog.push(view("child"), close(closed, "child"))
      dialog.push(view("grandchild"), close(closed, "grandchild"))
      await setup.flush()

      setup.mockInput.pressEscape()
      await setup.flush()
      expect(dialog.stack).toHaveLength(2)
      expect(Object.fromEntries(closed)).toEqual({ grandchild: 1 })

      await setup.mockMouse.click(1, 1)
      await setup.flush()
      expect(dialog.stack).toHaveLength(1)
      expect(Object.fromEntries(closed)).toEqual({ grandchild: 1, child: 1 })

      setup.mockInput.pressEscape()
      setup.mockInput.pressEscape()
      await setup.mockMouse.click(1, 1)
      await setup.flush()
      expect(dialog.stack).toHaveLength(0)
      expect(Object.fromEntries(closed)).toEqual({ grandchild: 1, child: 1, parent: 1 })
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the top entry can consume Escape before the stack dismisses it", async () => {
    let handled = 0
    const closed = new Map<string, number>()
    const setup = await renderDialog()
    const { dialog } = setup

    try {
      dialog.replace(() => <EscapeDialog handled={() => handled++} />, close(closed, "dialog"))
      await setup.flush()
      dialog.lock()

      setup.mockInput.pressEscape()
      await setup.flush()
      expect(handled).toBe(0)
      expect(dialog.stack).toHaveLength(1)
      expect(closed.get("dialog")).toBeUndefined()

      dialog.unlock()
      setup.mockInput.pressEscape()
      await setup.flush()

      expect(handled).toBe(1)
      expect(dialog.stack).toHaveLength(1)
      expect(closed.get("dialog")).toBeUndefined()
    } finally {
      setup.renderer.destroy()
    }
  })

  actions.forEach((action) => {
    test(`an Escape handler ${action.name} does not fall through to a second pop`, async () => {
      const closed = new Map<string, number>()
      const setup = await renderDialog()
      const { dialog } = setup

      try {
        dialog.replace(() => <text>parent</text>, close(closed, "parent"))
        dialog.push(
          () => <EscapeActionDialog action={(dialog) => action.run(dialog, closed)} />,
          close(closed, "child"),
        )
        await setup.flush()

        setup.mockInput.pressEscape()
        await setup.flush()

        expect(dialog.stack).toHaveLength(action.stack)
        expect(closed.get("child")).toBe(1)
        expect(closed.get("parent")).toBe(action.parent)
        expect(closed.get("replacement")).toBeUndefined()
      } finally {
        setup.renderer.destroy()
      }
    })
  })

  test("popping a child restores the mounted parent state, size, scroll, and focus", async () => {
    let mounts = 0
    const setup = await renderDialog(() => <OutsideInput />)
    const { dialog } = setup

    try {
      dialog.replace(() => <ParentDialog mounted={() => mounts++} />)
      await setup.flush()
      setup.mockInput.pressArrow("down")
      await setup.flush()
      const parent = setup.captureCharFrame()

      expect(parent).toContain("selected: second")
      expect(parent).toContain("row two")
      expect(dialog.size).toBe("large")
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("parent-input")

      dialog.push(() => <ChildDialog />)
      await setup.flush()
      expect(dialog.size).toBe("medium")
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("child-input")
      setup.mockInput.pressArrow("down")
      await setup.flush()

      dialog.pop()
      await setup.flush()
      expect(mounts).toBe(1)
      expect(dialog.size).toBe("large")
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("parent-input")
      expect(setup.captureCharFrame()).toBe(parent)

      dialog.clear()
      await setup.flush()
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("outside-input")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("provider unmount closes every remaining entry exactly once", async () => {
    const closed = new Map<string, number>()
    const setup = await renderDialog()
    const { dialog } = setup

    dialog.replace(() => <text>parent</text>, close(closed, "parent"))
    dialog.push(() => <text>child</text>, close(closed, "child"))
    dialog.lock()
    await setup.flush()
    setup.renderer.destroy()
    setup.renderer.destroy()

    expect(Object.fromEntries(closed)).toEqual({ child: 1, parent: 1 })
  })

  test("a new push cancels a pending refocus from the previous pop", async () => {
    const setup = await renderDialog()
    const { dialog } = setup

    try {
      dialog.replace(() => <FocusDialog id="parent-input" />)
      dialog.push(() => <FocusDialog id="first-child-input" />)
      await setup.flush()

      dialog.pop()
      dialog.push(() => <FocusDialog id="second-child-input" />)
      await setup.flush()

      expect(setup.renderer.currentFocusedRenderable?.id).toBe("second-child-input")
    } finally {
      setup.renderer.destroy()
    }
  })
})
