import { describe, expect, test } from "vitest"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, type Setter } from "solid-js"
import {
  createSubsessionDisclosure,
  SubsessionDisclosure,
} from "../../src/cli/cmd/tui/routes/session/subsession-disclosure"
import type { SessionMessageLoadState } from "../../src/cli/cmd/tui/context/session-message-loader"

const colors = {
  text: RGBA.fromInts(240, 240, 240),
  muted: RGBA.fromInts(160, 160, 160),
  error: RGBA.fromInts(240, 80, 80),
  action: RGBA.fromInts(80, 160, 240),
}

const labels = {
  expand: "Expand child session",
  collapse: "Collapse child session",
  loading: "Loading child session",
  empty: "No child session content",
  failed: "Failed to load child session",
  retry: "Retry",
}

interface Controls {
  state: Setter<SessionMessageLoadState>
  content: Setter<boolean>
  loads: () => number
  retries: () => number
  bubbles: () => number
}

async function render() {
  let controls!: Controls
  const setup = await testRender(
    () => {
      const [state, setState] = createSignal<SessionMessageLoadState>({ status: "idle" })
      const [content, setContent] = createSignal(false)
      const [sessionID] = createSignal<string | undefined>("session-child")
      let loads = 0
      let retries = 0
      let bubbles = 0
      const disclosure = createSubsessionDisclosure({
        sessionID,
        ensure: async () => {
          loads++
        },
      })
      controls = {
        state: setState,
        content: setContent,
        loads: () => loads,
        retries: () => retries,
        bubbles: () => bubbles,
      }
      return (
        <box onMouseUp={() => bubbles++}>
          <SubsessionDisclosure
            id="child"
            expanded={disclosure.expanded()}
            state={state()}
            hasContent={content()}
            labels={labels}
            colors={colors}
            onToggle={disclosure.toggle}
            onRetry={() => {
              retries++
              disclosure.retry()
            }}
          >
            <text>child marker</text>
          </SubsessionDisclosure>
        </box>
      )
    },
    { width: 60, height: 10 },
  )
  await setup.flush()
  return { setup, controls }
}

async function click(setup: Awaited<ReturnType<typeof testRender>>, id: string) {
  const target = setup.renderer.root.findDescendantById(id)
  if (!target) throw new Error(`missing renderable ${id}`)
  await setup.mockMouse.click(target.screenX, target.screenY)
  await setup.flush()
}

describe("SubsessionDisclosure", () => {
  test("opens before content exists and distinguishes loading from an empty result", async () => {
    const { setup, controls } = await render()
    try {
      expect(setup.captureCharFrame()).toContain(labels.expand)
      expect(setup.captureCharFrame()).not.toContain(labels.loading)

      await click(setup, "child-toggle")
      expect(controls.loads()).toBe(1)
      expect(controls.bubbles()).toBe(0)
      expect(setup.captureCharFrame()).toContain(labels.collapse)
      expect(setup.captureCharFrame()).toContain(labels.loading)

      controls.state({ status: "loaded" })
      await setup.flush()
      expect(setup.captureCharFrame()).toContain(labels.empty)
      expect(setup.captureCharFrame()).not.toContain("child marker")

      controls.content(true)
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("child marker")
      expect(setup.captureCharFrame()).not.toContain(labels.empty)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("keeps cached content visible on error and exposes retry without collapsing", async () => {
    const { setup, controls } = await render()
    try {
      await click(setup, "child-toggle")
      controls.content(true)
      controls.state({ status: "error", error: "offline" })
      await setup.flush()

      expect(setup.captureCharFrame()).toContain("child marker")
      expect(setup.captureCharFrame()).toContain(labels.failed)
      await click(setup, "child-retry")
      expect(controls.retries()).toBe(1)
      expect(controls.loads()).toBe(2)
      expect(controls.bubbles()).toBe(0)
      expect(setup.captureCharFrame()).toContain(labels.collapse)
    } finally {
      setup.renderer.destroy()
    }
  })
})
