import { describe, expect, test } from "vitest"
import { destroyRenderer } from "../../../src/cli/cmd/tui/util/renderer"

describe("TUI renderer lifecycle", () => {
  test("clears the title and destroys an active renderer", () => {
    let title = "MerakCode"
    let destroyed = 0
    const renderer = {
      isDestroyed: false,
      setTerminalTitle(value: string) {
        title = value
      },
      destroy() {
        destroyed++
        renderer.isDestroyed = true
      },
    }

    destroyRenderer(renderer)

    expect(title).toBe("")
    expect(destroyed).toBe(1)
  })

  test("leaves an already destroyed renderer alone", () => {
    let destroyed = 0
    const renderer = {
      isDestroyed: true,
      // Like opentui: setting the title after the native session ends throws
      setTerminalTitle() {
        throw new Error("ot_session_control failed: InvalidPhase")
      },
      destroy() {
        destroyed++
      },
    }

    expect(() => destroyRenderer(renderer)).not.toThrow()
    expect(destroyed).toBe(0)
  })
})
