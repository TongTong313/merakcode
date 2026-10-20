import { describe, expect, test } from "vitest"
import { createSingleFlight } from "../../../src/cli/cmd/tui/util/single-flight"

describe("createSingleFlight", () => {
  test("concurrent calls share one run", async () => {
    let calls = 0
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = createSingleFlight(async () => {
      calls++
      await pending
    })
    const first = run()
    expect(run()).toBe(first)
    expect(calls).toBe(1)
    release()
    await first
  })

  test("a finished run lets the next call start again", async () => {
    let calls = 0
    const run = createSingleFlight(async () => {
      calls++
    })
    await run()
    await run()
    expect(calls).toBe(2)
  })
})
