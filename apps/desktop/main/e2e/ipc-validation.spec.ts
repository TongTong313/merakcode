import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"
import { test, expect } from "./fixture"

test("invalid close confirmations and storage enumeration inputs retain their refusal behavior", async ({ kit }) => {
  const result = await kit.page.evaluate(async () => {
    const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
    await bridge.storageSet("validation-fixture", "key", "retained")
    const closed = []
    const entries = []
    for (const value of [undefined, null, 1, "true", {}, []]) {
      closed.push(await bridge.completeClose(value as boolean))
      await bridge.completeResourceClose(value as boolean)
      entries.push(await bridge.storageEntries(value as string))
    }
    return { closed, entries, saved: await bridge.storageEntries("validation-fixture") }
  })
  expect(result.closed).toEqual([false, false, false, false, false, false])
  expect(result.entries).toEqual([[], [], [], [], [], []])
  expect(result.saved).toEqual([["key", "retained"]])
  await expect(kit.page.getByRole("button", { name: "右侧面板", exact: true })).toBeVisible()
})
