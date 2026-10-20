import { describe, expect, test } from "vitest"
import z from "zod"
import { Tool } from "@merakcode/engine/tool/tool"

/**
 * Regression: Tool.define with a static object literal must not stack wrappers.
 *
 * When init is a shared module-level literal and its reference is reused, the wrapped execute is written back to the
 * shared object, and every init() wraps the already wrapped execute again. Counting calls to the original execute
 * after several init() calls proves the wrappers no longer stack.
 */
describe("Tool.define does not re-wrap execute", () => {
  // The original execute already sets metadata.truncated, so the wrapper skips Truncate.output and the test needs no
  // truncation or agent setup.
  function makeStaticTool(id: string, counter: { calls: number }) {
    return Tool.define(id, {
      description: "regression",
      parameters: z.object({}),
      execute: async () => {
        counter.calls++
        return { title: "t", metadata: { truncated: false }, output: "out" }
      },
    })
  }

  test("a static literal tool is wrapped once after repeated init", async () => {
    const counter = { calls: 0 }
    const def = makeStaticTool("regression-no-rewrap", counter)

    await def.init()
    // With stacked wrappers, one call here would run the original execute twice
    const second = await def.init()
    await second.execute({} as never, {} as never)

    expect(counter.calls).toBe(1)
  })

  test("executes from two init calls are independent and each wrapped once", async () => {
    const counter = { calls: 0 }
    const def = makeStaticTool("regression-independent", counter)

    const first = await def.init()
    const second = await def.init()
    await first.execute({} as never, {} as never)
    await second.execute({} as never, {} as never)

    expect(counter.calls).toBe(2)
  })

  test("a function init wraps each instance independently", async () => {
    const counter = { calls: 0 }
    const def = Tool.define("fn-init", async () => ({
      description: "fn",
      parameters: z.object({}),
      execute: async () => {
        counter.calls++
        return { title: "t", metadata: { truncated: false }, output: "out" }
      },
    }))

    const first = await def.init()
    const second = await def.init()
    await first.execute({} as never, {} as never)
    await second.execute({} as never, {} as never)

    expect(counter.calls).toBe(2)
  })
})
