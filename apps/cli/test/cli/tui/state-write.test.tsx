import { afterEach, beforeEach, expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { testRender } from "@opentui/solid"
import { Paths } from "@merakcode/util/paths"
import { KVProvider, useKV } from "../../../src/cli/cmd/tui/context/kv"

// When the state directory is not writable (disk full, wrong permissions...), a preference is simply not saved and the
// UI keeps working; it must not become a process-level unhandled rejection
const rejections: unknown[] = []
const record = (reason: unknown) => rejections.push(reason)
let saved: string

beforeEach(async () => {
  rejections.length = 0
  process.on("unhandledRejection", record)
  // Replace the state directory with a plain file, so creating files under it always fails
  saved = Paths.state
  const blocked = `${saved}-blocked`
  await fs.mkdir(path.dirname(blocked), { recursive: true })
  await fs.writeFile(blocked, "")
  Paths.state = blocked
})

afterEach(async () => {
  process.off("unhandledRejection", record)
  await fs.rm(Paths.state, { force: true })
  Paths.state = saved
})

test("saving a preference to an unwritable state directory raises no unhandled rejection", async () => {
  let kv: ReturnType<typeof useKV> | undefined
  function Probe() {
    kv = useKV()
    return <text>ok</text>
  }
  const setup = await testRender(
    () => (
      <KVProvider>
        <Probe />
      </KVProvider>
    ),
    { width: 10, height: 1 },
  )
  try {
    // Children render only after the state file is read (here the read fails)
    for (let i = 0; i < 40 && !kv; i++) {
      await setup.flush()
      await delay(5)
    }
    kv!.set("animations_enabled", false)
    expect(kv!.get("animations_enabled")).toBe(false)
    await delay(50)
    expect(rejections).toEqual([])
  } finally {
    setup.renderer.destroy()
  }
})
